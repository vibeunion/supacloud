import { Worker, MessagePort } from "worker_threads";

interface DispatchOptions {
  functionId: string;
  functionPath: string;
  projectRoot: string;
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

const MAX_BODY_SIZE = 10 * 1024 * 1024;
const MAX_QUEUE_SIZE = Number(process.env.MAX_QUEUE_SIZE) || 200;
const WORKER_SMOL = process.env.WORKER_SMOL !== "false";

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
      replacementTimer?: ReturnType<typeof setTimeout>;
      isCancelling?: boolean;
    }
  >();
  private tainted = new Set<Worker>();
  private draining = false;

  constructor(private config: { size: number; requestTimeout: number }) {
    for (let i = 0; i < config.size; i++) {
      const w = this.createWorker();
      this.idle.push(w);
      this.activeWorkers.add(w);
    }
  }

  private createWorker(): Worker {
    const w = new Worker(new URL("./worker-executor.ts", import.meta.url).href, {
      ...(WORKER_SMOL ? { smol: true } : {}),
    } as any);
    this.workers.push(w);
    this.workerMetadata.set(w, {});
    return w;
  }

  async dispatch(opts: DispatchOptions): Promise<Response> {
    if (this.draining) {
      return new Response(JSON.stringify({ error: "Server is shutting down" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    this.totalRequests++;
    return new Promise<Response>((resolve, reject) => {
      if (this.queue.length >= MAX_QUEUE_SIZE) {
        resolve(new Response(JSON.stringify({ error: "Too many concurrent requests, please retry" }), {
          status: 503,
          headers: { "Content-Type": "application/json", "Retry-After": "5" },
        }));
        return;
      }

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
      if (resolved) return;
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

    const headers: Record<string, string | string[]> = {};
    opts.request.headers.forEach((v, k) => {
      const lower = k.toLowerCase();
      if (lower === "set-cookie") {
      } else {
        headers[k] = v;
      }
    });
    const cookies = (opts.request.headers as any).getSetCookie?.();
    if (cookies && cookies.length > 0) {
      headers["set-cookie"] = cookies;
    }

    let body: ArrayBuffer | null = null;
    if (opts.request.body && !["GET", "HEAD"].includes(opts.request.method)) {
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
      projectRoot: opts.projectRoot,
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
      headers?: Record<string, string | string[]>;
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

      const isResponseMessage =
        typeof msg.status === "number" || msg.type === "stream_start";
      if (!isResponseMessage) {
        return;
      }

      clearTimeout(timeout);
      cleanupInFlight();
      clearCancellationState();
      worker.removeListener("error", onErr);
      worker.removeListener("message", onMsg);

      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(msg.headers ?? {})) {
        if (Array.isArray(v)) {
          for (const val of v) resHeaders.append(k, val);
        } else {
          resHeaders.set(k, v);
        }
      }

      if (msg.type === "stream_start" && msg.streamId) {
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
    if (this.tainted.has(worker)) {
      this.tainted.delete(worker);
      this.replaceWorker(worker);
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
    this.activeWorkers.delete(dead);
    try {
      dead.terminate();
    } catch {
    }
    const w = this.createWorker();
    this.activeWorkers.add(w);
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

  invalidateModule(functionId: string): void {
    this.totalInvalidations++;
    console.log(`[Pool] Invalidating module: ${functionId} — replacing all workers`);

    const freshIdle: Worker[] = [];
    for (const w of this.idle) {
      this.activeWorkers.delete(w);
      const idx = this.workers.indexOf(w);
      if (idx !== -1) this.workers.splice(idx, 1);
      try { w.terminate(); } catch { }

      const fresh = this.createWorker();
      this.activeWorkers.add(fresh);
      freshIdle.push(fresh);
    }
    this.idle = freshIdle;

    for (const w of this.activeWorkers) {
      if (!this.idle.includes(w)) {
        this.tainted.add(w);
      }
    }
  }

  preheat(functionId: string, functionPath: string, projectRoot: string, env: Record<string, string>): Promise<boolean> {
    return new Promise((resolve) => {
      const worker = this.idle.pop();
      if (!worker) {
        resolve(false);
        return;
      }

      const timeout = setTimeout(() => {
        worker.removeListener("message", onMsg);
        this.idle.push(worker);
        resolve(false);
      }, 10000);

      const onMsg = (msg: { type?: string; functionId?: string }) => {
        if (msg.type === "preheat_done" && msg.functionId === functionId) {
          clearTimeout(timeout);
          worker.removeListener("message", onMsg);
          this.idle.push(worker);
          resolve(true);
        } else if (
          msg.type === "preheat_error" &&
          msg.functionId === functionId
        ) {
          clearTimeout(timeout);
          worker.removeListener("message", onMsg);
          this.idle.push(worker);
          resolve(false);
        }
      };

      worker.on("message", onMsg);
      worker.postMessage({ type: "preheat", functionId, functionPath, projectRoot, env });
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

  get activeCount(): number {
    return this.inFlight.size;
  }

  drain(): Promise<void> {
    this.draining = true;
    for (const entry of this.queue) {
      entry.resolve(new Response(JSON.stringify({ error: "Server shutting down" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }));
    }
    this.queue = [];

    return new Promise((resolve) => {
      const check = () => {
        if (this.inFlight.size === 0) {
          resolve();
          return;
        }
        setTimeout(check, 500);
      };
      check();
    });
  }
}
