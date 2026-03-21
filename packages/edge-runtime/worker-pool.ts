import { Worker } from "worker_threads";

interface DispatchOptions {
  functionId: string;
  functionPath: string;
  env: Record<string, string>;
  request: Request;
}

export class WorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Array<{
    opts: DispatchOptions;
    resolve: (r: Response) => void;
  }> = [];
  private totalRequests = 0;

  constructor(
    private config: { size: number; requestTimeout: number },
  ) {
    for (let i = 0; i < config.size; i++) {
      this.idle.push(this.createWorker());
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
    return new Promise(async (resolve) => {
      const worker = this.idle.pop();
      if (worker) {
        await this.execute(worker, opts, resolve);
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
    const timeout = setTimeout(() => {
      resolve(new Response("Gateway Timeout", { status: 504 }));
      this.recycle(worker);
    }, this.config.requestTimeout);

    const headers: Record<string, string> = {};
    opts.request.headers.forEach((v, k) => (headers[k] = v));

    let body: ArrayBuffer | null = null;
    if (
      opts.request.body &&
      !["GET", "HEAD"].includes(opts.request.method)
    ) {
      body = await opts.request.arrayBuffer();
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
      headers: Record<string, string>;
      body: ArrayBuffer;
    }) => {
      clearTimeout(timeout);
      worker.removeListener("error", onErr);
      resolve(
        new Response(msg.body, {
          status: msg.status,
          headers: msg.headers,
        }),
      );
      this.recycle(worker);
    };

    const onErr = (err: Error) => {
      clearTimeout(timeout);
      worker.removeListener("message", onMsg);
      console.error("[Pool] Worker error:", err);
      resolve(new Response("Internal Error", { status: 500 }));
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
    try {
      dead.terminate();
    } catch {
      /* ignore */
    }
    const w = this.createWorker();
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
}
