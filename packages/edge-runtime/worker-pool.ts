import { Worker, MessagePort } from "worker_threads";

interface DispatchOptions {
  functionId: string;
  functionPath: string;
  env: Record<string, string>;
  request: Request;
  cancelKey?: string;
  onLog?: (entry: {
    timestamp: string;
    stream: "stdout" | "stderr";
    level: string;
    message: string;
  }) => void;
}

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB limit

export class WorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Array<{
    opts: DispatchOptions;
    resolve: (r: Response) => void;
  }> = [];
  private inFlight = new Map<string, { cancel: () => void }>();
  private totalRequests = 0;
  private totalInvalidations = 0;
  private activeWorkers = new Set<Worker>();
  private workerMetadata = new Map<
    Worker,
    {
      cancelKey?: string;
      replacementTimer?: Timer;
      isCancelling?: boolean;
    }
  >();
  // Workers marked for replacement after they finish their current request.
  // This avoids dropping in-flight requests while ensuring stale module caches are purged.
  private tainted = new Set<Worker>();

  constructor(private config: { size: number; requestTimeout: number }) {
    for (let i = 0; i < config.size; i++) {
      const w = this.createWorker();
      this.idle.push(w);
      this.activeWorkers.add(w);
    }
  }

  private createWorker(): Worker {
    const w = new Worker(new URL("./worker-executor.ts", import.meta.url).href);
    this.workers.push(w);
    this.workerMetadata.set(w, {});
    return w;
  }

  async dispatch(opts: DispatchOptions): Promise<Response> {
    this.totalRequests++;
    return new Promise<Response>((resolve, reject) => {
      const worker = this.idle.pop();
      if (worker) {
        this.execute(worker, opts, resolve).catch(reject);
      } else {
        this.queue.push({ opts, resolve });
      }
    });
  }

  private async execute(
    worker: Worker,
    opts: DispatchOptions,
    resolve: (r: Response) => void,
  ) {
    const cancelGraceMs = 3_000;
    const cancelledResponse = () =>
      new Response(JSON.stringify({ error: "Task cancelled" }), {
        status: 499,
        headers: { "Content-Type": "application/json" },
      });

    let resolved = false;
    const safeResolve = (r: Response) => {
      if (resolved) return; // Prevent double-resolve (e.g. timeout + late response)
      resolved = true;
      resolve(r);
    };
    const cleanupInFlight = () => {
      if (opts.cancelKey) this.inFlight.delete(opts.cancelKey);
    };
    const metadata = this.workerMetadata.get(worker) || {};
    metadata.cancelKey = opts.cancelKey;
    metadata.isCancelling = false;
    if (metadata.replacementTimer) {
      clearTimeout(metadata.replacementTimer);
      metadata.replacementTimer = undefined;
    }
    this.workerMetadata.set(worker, metadata);
    const clearCancellationState = () => {
      const current = this.workerMetadata.get(worker);
      if (!current) return;
      current.cancelKey = undefined;
      current.isCancelling = false;
      if (current.replacementTimer) {
        clearTimeout(current.replacementTimer);
        current.replacementTimer = undefined;
      }
    };

    const timeout = setTimeout(() => {
      cleanupInFlight();
      clearCancellationState();
      safeResolve(new Response("Gateway Timeout", { status: 504 }));
      this.recycle(worker);
    }, this.config.requestTimeout);

    // Preserve duplicate headers (e.g. set-cookie) by using getSetCookie() + entries()
    const headers: Record<string, string | string[]> = {};
    opts.request.headers.forEach((v, k) => {
      const lower = k.toLowerCase();
      if (lower === "set-cookie") {
        // Handled below
      } else {
        headers[k] = v;
      }
    });
    // set-cookie must be sent as an array to preserve multiple values
    const cookies = (opts.request.headers as any).getSetCookie?.();
    if (cookies && cookies.length > 0) {
      headers["set-cookie"] = cookies;
    }

    let body: ArrayBuffer | null = null;
    if (opts.request.body && !["GET", "HEAD"].includes(opts.request.method)) {
      // Enforce body size limit to prevent OOM
      const contentLength = opts.request.headers.get("content-length");
      if (contentLength && parseInt(contentLength) > MAX_BODY_SIZE) {
        clearCancellationState();
        safeResolve(
          new Response(
            JSON.stringify({
              error: `Request body too large (max ${MAX_BODY_SIZE / 1024 / 1024}MB)`,
            }),
            {
              status: 413,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
        this.recycle(worker);
        clearTimeout(timeout);
        return;
      }
      body = await opts.request.arrayBuffer();
      if (body.byteLength > MAX_BODY_SIZE) {
        clearCancellationState();
        safeResolve(
          new Response(
            JSON.stringify({
              error: `Request body too large (max ${MAX_BODY_SIZE / 1024 / 1024}MB)`,
            }),
            {
              status: 413,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
        this.recycle(worker);
        clearTimeout(timeout);
        return;
      }
    }

    worker.postMessage({
      functionId: opts.functionId,
      functionPath: opts.functionPath,
      env: opts.env,
      url: opts.request.url,
      method: opts.request.method,
      headers,
      body,
    });

    if (opts.cancelKey) {
      this.inFlight.set(opts.cancelKey, {
        cancel: () => {
          const current = this.workerMetadata.get(worker);
          if (current?.isCancelling) return;
          if (current) current.isCancelling = true;
          clearTimeout(timeout);
          try {
            worker.postMessage({ type: "cancel_current" });
          } catch {
            // ignore
          }
          cleanupInFlight();
          if (current) {
            current.replacementTimer = setTimeout(() => {
              worker.removeListener("message", onMsg);
              worker.removeListener("error", onErr);
              clearCancellationState();
              safeResolve(cancelledResponse());
              this.replaceWorker(worker);
            }, cancelGraceMs);
          }
        },
      });
    }

    const onMsg = (msg: {
      type?: string;
      status: number;
      streamId?: string;
      headers: Record<string, string | string[]>;
      body?: ArrayBuffer;
      timestamp?: string;
      stream?: "stdout" | "stderr";
      level?: string;
      message?: string;
    }) => {
      if (msg.type === "log" && opts.onLog && msg.timestamp && msg.stream && msg.level && msg.message) {
        opts.onLog({
          timestamp: msg.timestamp,
          stream: msg.stream,
          level: msg.level,
          message: msg.message,
        });
        return;
      }

      if (msg.type === "cancel_ack") {
        return;
      }

      clearTimeout(timeout);
      cleanupInFlight();
      clearCancellationState();
      worker.removeListener("error", onErr);
      worker.removeListener("message", onMsg);

      // Reconstruct Headers from the serialized map, preserving multi-value headers
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(msg.headers)) {
        if (Array.isArray(v)) {
          for (const val of v) resHeaders.append(k, val);
        } else {
          resHeaders.set(k, v);
        }
      }

      if (msg.type === "stream_start" && msg.streamId) {
        // Streaming response: create a ReadableStream backed by custom message events
        const streamId = msg.streamId;
        let recycled = false;
        const recycle = () => {
          if (!recycled) {
            recycled = true;
            clearCancellationState();
            this.recycle(worker);
          }
        };

        const bodyStream = new ReadableStream<Uint8Array>({
          start(controller) {
            const streamListener = (streamMsg: any) => {
              if (streamMsg.type === "stream_chunk" && streamMsg.streamId === streamId) {
                if (streamMsg.done) {
                  if (streamMsg.error) {
                    controller.error(new Error(streamMsg.error));
                  } else {
                    controller.close();
                  }
                  worker.removeListener("message", streamListener);
                  recycle();
                } else if (streamMsg.chunk) {
                  controller.enqueue(new Uint8Array(streamMsg.chunk));
                }
              }
            };
            worker.on("message", streamListener);
          },
          cancel() {
            recycle();
          },
        });

        safeResolve(
          new Response(bodyStream, {
            status: msg.status,
            headers: resHeaders,
          }),
        );
        // Worker is recycled only after the stream ends (via recycle callback above)
      } else {
        safeResolve(
          new Response(msg.body, {
            status: msg.status,
            headers: resHeaders,
          }),
        );
        this.recycle(worker);
      }
    };

    const onErr = (err: Error) => {
      clearTimeout(timeout);
      cleanupInFlight();
      clearCancellationState();
      worker.removeListener("message", onMsg);
      console.error("[Pool] Worker error:", err);
      safeResolve(new Response("Internal Error", { status: 500 }));
      this.replaceWorker(worker);
    };

    worker.on("message", onMsg);
    worker.once("error", onErr);
  }

  private recycle(worker: Worker) {
    const metadata = this.workerMetadata.get(worker);
    if (metadata?.replacementTimer) {
      clearTimeout(metadata.replacementTimer);
      metadata.replacementTimer = undefined;
    }
    if (metadata) {
      metadata.cancelKey = undefined;
      metadata.isCancelling = false;
    }
    // If the worker is tainted (stale module cache), replace it with a fresh one
    // instead of returning it to the idle pool.
    if (this.tainted.has(worker)) {
      this.tainted.delete(worker);
      this.replaceWorker(worker);
      // The fresh worker was pushed to idle by replaceWorker;
      // drain the queue if there are pending requests.
      if (this.queue.length > 0 && this.idle.length > 0) {
        const fresh = this.idle.pop()!;
        const next = this.queue.shift()!;
        this.execute(fresh, next.opts, next.resolve);
      }
      return;
    }

    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.execute(worker, next.opts, next.resolve);
    } else {
      this.idle.push(worker);
    }
  }

  private replaceWorker(dead: Worker) {
    const metadata = this.workerMetadata.get(dead);
    if (metadata?.replacementTimer) clearTimeout(metadata.replacementTimer);
    this.workerMetadata.delete(dead);
    const idx = this.workers.indexOf(dead);
    if (idx !== -1) this.workers.splice(idx, 1);
    this.activeWorkers.delete(dead); // Remove from tracking set
    try {
      dead.terminate();
    } catch {
      /* ignore */
    }
    const w = this.createWorker();
    this.activeWorkers.add(w); // Track new worker
    this.idle.push(w);
  }

  getMetrics(): string {
    return [
      `supacloud_edge_active_workers ${this.config.size - this.idle.length}`,
      `supacloud_edge_idle_workers ${this.idle.length}`,
      `supacloud_edge_queue_length ${this.queue.length}`,
      `supacloud_edge_total_requests ${this.totalRequests}`,
      `supacloud_edge_total_invalidations ${this.totalInvalidations}`,
      `supacloud_edge_tainted_workers ${this.tainted.size}`,
    ].join("\n");
  }

  /**
   * Invalidate all workers' module caches by replacing them.
   *
   * Strategy (graceful, zero-downtime):
   *   - Idle workers → terminate immediately, replace with fresh ones
   *   - Busy workers → mark as "tainted"; they'll be replaced in recycle()
   *     after their current request completes (no in-flight drops)
   *
   * This is the same approach used by Deno Deploy and Cloudflare Workers:
   * new Worker threads have completely clean module caches, eliminating
   * Bun's import() cache staleness issue without hacks or memory leaks.
   */
  invalidateModule(functionId: string): void {
    this.totalInvalidations++;
    console.log(`[Pool] Invalidating module: ${functionId} — replacing all workers`);

    // 1. Replace all idle workers immediately
    const freshIdle: Worker[] = [];
    for (const w of this.idle) {
      this.activeWorkers.delete(w);
      const idx = this.workers.indexOf(w);
      if (idx !== -1) this.workers.splice(idx, 1);
      try { w.terminate(); } catch { /* ignore */ }

      const fresh = this.createWorker();
      this.activeWorkers.add(fresh);
      freshIdle.push(fresh);
    }
    this.idle = freshIdle;

    // 2. Mark all busy workers as tainted — they'll be replaced in recycle()
    for (const w of this.activeWorkers) {
      if (!this.idle.includes(w)) {
        this.tainted.add(w);
      }
    }
  }

  /**
   * Pre-heat a function in the worker pool — import the module ahead of time
   * so the first real request has zero cold-start latency.
   * Only pre-heats in one idle worker (the module will be cached in LRU).
   */
  preheat(functionId: string, functionPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const worker = this.idle[0]; // peek at first idle worker without removing it
      if (!worker) {
        resolve(false); // No idle workers available
        return;
      }

      const timeout = setTimeout(() => {
        worker.removeListener("message", onMsg);
        resolve(false); // Preheat timed out
      }, 10000);

      const onMsg = (msg: { type?: string; functionId?: string }) => {
        if (msg.type === "preheat_done" && msg.functionId === functionId) {
          clearTimeout(timeout);
          worker.removeListener("message", onMsg);
          resolve(true);
        } else if (
          msg.type === "preheat_error" &&
          msg.functionId === functionId
        ) {
          clearTimeout(timeout);
          worker.removeListener("message", onMsg);
          resolve(false);
        }
        // Non-matching messages (normal request responses) are ignored;
        // the listener stays until preheat completes or times out.
      };

      worker.on("message", onMsg);
      worker.postMessage({ type: "preheat", functionId, functionPath });
    });
  }

  snapshotMetrics(prefix = "supacloud_edge"): Record<string, number> {
    return {
      [`${prefix}_active_workers`]: this.config.size - this.idle.length,
      [`${prefix}_idle_workers`]: this.idle.length,
      [`${prefix}_queue_length`]: this.queue.length,
      [`${prefix}_total_requests`]: this.totalRequests,
      [`${prefix}_total_invalidations`]: this.totalInvalidations,
      [`${prefix}_tainted_workers`]: this.tainted.size,
    };
  }

  cancel(cancelKey: string): boolean {
    const queuedIndex = this.queue.findIndex((entry) => entry.opts.cancelKey === cancelKey);
    if (queuedIndex >= 0) {
      const [queued] = this.queue.splice(queuedIndex, 1);
      queued.resolve(
        new Response(JSON.stringify({ error: "Task cancelled" }), {
          status: 499,
          headers: { "Content-Type": "application/json" },
        }),
      );
      return true;
    }

    const inFlight = this.inFlight.get(cancelKey);
    if (!inFlight) return false;
    inFlight.cancel();
    return true;
  }
}
