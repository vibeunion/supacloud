import { Worker } from "worker_threads";

interface DispatchOptions {
  functionId: string;
  functionPath: string;
  env: Record<string, string>;
  request: Request;
}

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB limit

export class WorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Array<{
    opts: DispatchOptions;
    resolve: (r: Response) => void;
  }> = [];
  private totalRequests = 0;
  private activeWorkers = new Set<Worker>(); // Track all living workers for invalidation

  constructor(
    private config: { size: number; requestTimeout: number },
  ) {
    for (let i = 0; i < config.size; i++) {
      const w = this.createWorker();
      this.idle.push(w);
      this.activeWorkers.add(w);
    }
  }

  private createWorker(): Worker {
    const w = new Worker(
      new URL("./worker-executor.ts", import.meta.url).href,
    );
    this.workers.push(w);
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
    let resolved = false;
    const safeResolve = (r: Response) => {
      if (resolved) return; // Prevent double-resolve (e.g. timeout + late response)
      resolved = true;
      resolve(r);
    };

    const timeout = setTimeout(() => {
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
    if (
      opts.request.body &&
      !["GET", "HEAD"].includes(opts.request.method)
    ) {
      // Enforce body size limit to prevent OOM
      const contentLength = opts.request.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > MAX_BODY_SIZE) {
        safeResolve(new Response(JSON.stringify({ error: `Request body too large (max ${MAX_BODY_SIZE / 1024 / 1024}MB)` }), {
          status: 413,
          headers: { "Content-Type": "application/json" },
        }));
        this.recycle(worker);
        clearTimeout(timeout);
        return;
      }
      body = await opts.request.arrayBuffer();
      if (body.byteLength > MAX_BODY_SIZE) {
        safeResolve(new Response(JSON.stringify({ error: `Request body too large (max ${MAX_BODY_SIZE / 1024 / 1024}MB)` }), {
          status: 413,
          headers: { "Content-Type": "application/json" },
        }));
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

    const onMsg = (msg: {
      status: number;
      headers: Record<string, string | string[]>;
      body: ArrayBuffer;
    }) => {
      clearTimeout(timeout);
      worker.removeListener("error", onErr);
      // Reconstruct Headers from the serialized map, preserving multi-value headers
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(msg.headers)) {
        if (Array.isArray(v)) {
          for (const val of v) resHeaders.append(k, val);
        } else {
          resHeaders.set(k, v);
        }
      }
      safeResolve(
        new Response(msg.body, {
          status: msg.status,
          headers: resHeaders,
        }),
      );
      this.recycle(worker);
    };

    const onErr = (err: Error) => {
      clearTimeout(timeout);
      worker.removeListener("message", onMsg);
      console.error("[Pool] Worker error:", err);
      safeResolve(new Response("Internal Error", { status: 500 }));
      this.replaceWorker(worker);
    };

    worker.once("message", onMsg);
    worker.once("error", onErr);
  }

  private recycle(worker: Worker) {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.execute(worker, next.opts, next.resolve);
    } else {
      this.idle.push(worker);
    }
  }

  private replaceWorker(dead: Worker) {
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
    ].join("\n");
  }

  /** Notify all workers to evict a function from their module cache */
  invalidateModule(functionId: string): void {
    for (const w of this.activeWorkers) {
      w.postMessage({ type: "invalidate", functionId });
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
        } else if (msg.type === "preheat_error" && msg.functionId === functionId) {
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
}
