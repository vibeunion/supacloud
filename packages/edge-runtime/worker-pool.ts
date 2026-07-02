import { Worker, MessagePort } from "worker_threads";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { resolveEdgeFetchTlsPolicy } from "./fetch-tls-policy";
import type { EdgeFetchTlsPolicy } from "./fetch-tls-policy";
import { EMBEDDED_WORKER_HASH, EMBEDDED_WORKER_SOURCE } from "./generated/embedded-worker";

interface DispatchOptions {
  functionId: string;
  functionPath: string;
  projectRoot: string;
  projectRef?: string;
  moduleVersion?: string;
  env: Record<string, string>;
  request: Request;
  cancelKey?: string;
  envLoadMs?: number;
  onLog?: (entry: {
    timestamp: string;
    stream: "stdout" | "stderr";
    level: string;
    message: string;
  }) => void;
}

const DEFAULT_MAX_BODY_SIZE_MB = 30;
function resolveMaxBodySizeBytes(value = process.env.EDGE_MAX_BODY_SIZE_MB): number {
  const configuredMb = Number(value);
  const maxBodySizeMb = Number.isFinite(configuredMb) && configuredMb > 0
    ? configuredMb
    : DEFAULT_MAX_BODY_SIZE_MB;
  return maxBodySizeMb * 1024 * 1024;
}

const MAX_BODY_SIZE = resolveMaxBodySizeBytes();
const MAX_QUEUE_SIZE = Number(process.env.MAX_QUEUE_SIZE) || 200;
const WAIT_UNTIL_TIMEOUT_MS = Number(process.env.EDGE_WAIT_UNTIL_TIMEOUT_MS) || 300_000;
const CONTROL_MESSAGE_TIMEOUT_MS = Number(process.env.EDGE_CONTROL_MESSAGE_TIMEOUT_MS) || 1_000;

type WorkerControlMessage =
  | { type: "invalidate_module"; functionId: string }
  | { type: "invalidate_project"; projectRef: string };

type WorkerPoolControlResult = {
  attempted: number;
  succeeded: number;
  invalidated: number;
};

type WorkerControlAck = {
  acked: boolean;
  invalidated: number;
  moduleCacheSize: number;
};

type PreheatOptions = {
  projectRef?: string;
  moduleVersion?: string;
  maxWorkers?: number;
};

type WorkerPreheatResult = {
  success: boolean;
  cacheHit: boolean | null;
  moduleCacheSize: number;
};

export type WorkerPoolPreheatResult = {
  attempted: number;
  succeeded: number;
  cacheHits: number;
  cacheMisses: number;
  durationMs: number;
};

function extractProjectRef(functionId: string): string | null {
  const idx = functionId.indexOf("_");
  if (idx === -1) return null;
  return functionId.substring(0, idx);
}

function resolveWorkerEntry(): string | URL {
  if (process.env.EDGE_RUNTIME_WORKER_PATH) {
    return path.resolve(process.env.EDGE_RUNTIME_WORKER_PATH);
  }

  const sourceEntry = path.resolve(import.meta.dir, "worker-executor.ts");
  if (existsSync(sourceEntry)) {
    return sourceEntry;
  }

  if (!EMBEDDED_WORKER_SOURCE || !EMBEDDED_WORKER_HASH) {
    return new URL("./worker-executor.ts", import.meta.url);
  }

  const cacheDir = path.join(tmpdir(), "supacloud-edge-runtime");
  const embeddedEntry = path.join(cacheDir, `worker-executor-${EMBEDDED_WORKER_HASH}.mjs`);
  if (!existsSync(embeddedEntry)) {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(embeddedEntry, EMBEDDED_WORKER_SOURCE, { mode: 0o600 });
  }
  return embeddedEntry;
}

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
  private totalEnvLoadMs = 0;
  private totalQueueWaitMs = 0;
  private totalWorkerExecMs = 0;
  private totalModuleCacheHits = 0;
  private totalModuleCacheMisses = 0;
  private totalModuleCacheInvalidated = 0;
  private lastModuleCacheEntries = 0;
  private totalWorkerReplacements = 0;
  private totalPreheatAttempts = 0;
  private totalPreheatSucceeded = 0;
  private totalPreheatMs = 0;
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

  constructor(private config: { size: number; requestTimeout: number; smol?: boolean }) {
    for (let i = 0; i < config.size; i++) {
      const w = this.createWorker();
      this.idle.push(w);
      this.activeWorkers.add(w);
    }
  }

  private createWorker(): Worker {
    const workerEntry = resolveWorkerEntry();
    const w = new Worker(workerEntry, {
      ...(this.config.smol ? { smol: true } : {}),
    } as any);
    this.workers.push(w);
    this.workerMetadata.set(w, {});
    return w;
  }

  private resolveTlsPolicy(env: Record<string, string>): Promise<EdgeFetchTlsPolicy> {
    // Bun smol workers do not reliably inherit the parent process env. Resolve
    // host-controlled TLS policy in the main process and pass it as message data.
    return resolveEdgeFetchTlsPolicy(env, process.env);
  }

  async dispatch(opts: DispatchOptions): Promise<Response> {
    if (this.draining) {
      return new Response(JSON.stringify({ error: "Server is shutting down" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    this.totalRequests++;
    if (opts.envLoadMs) this.totalEnvLoadMs += opts.envLoadMs;
    const queueStart = performance.now();
    return new Promise<Response>((resolve, reject) => {
      if (this.queue.length >= MAX_QUEUE_SIZE) {
        resolve(new Response(JSON.stringify({ error: "Too many concurrent requests, please retry" }), {
          status: 503,
          headers: { "Content-Type": "application/json", "Retry-After": "5" },
        }));
        return;
      }

      (opts as any)._queueStart = queueStart;
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
    const queueStart = (opts as any)._queueStart as number | undefined;
    const queueWaitMs = queueStart ? Math.round(performance.now() - queueStart) : 0;
    this.totalQueueWaitMs += queueWaitMs;
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

    const execStart = performance.now();
    const tlsPolicy = await this.resolveTlsPolicy(opts.env);
    worker.postMessage({
      functionId: opts.functionId,
      functionPath: opts.functionPath,
      projectRoot: opts.projectRoot,
      projectRef: opts.projectRef,
      moduleVersion: opts.moduleVersion,
      env: opts.env,
      tlsPolicy,
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

    let waitUntilTimeout: ReturnType<typeof setTimeout> | undefined;

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
      waitUntilPending?: boolean;
      moduleCacheHit?: boolean;
      moduleCacheSize?: number;
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

      if (msg.type === "wait_until_done") {
        clearTimeout(timeout);
        cleanupInFlight();
        clearCancellationState();
        worker.removeListener("error", onErr);
        worker.removeListener("message", onMsg);
        this.recycle(worker);
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

      const workerExecMs = Math.round(performance.now() - execStart);
      this.totalWorkerExecMs += workerExecMs;
      this.recordModuleCacheStats(msg);
      clearTimeout(timeout);
      cleanupInFlight();
      clearCancellationState();
      const waitUntilPending = msg.waitUntilPending === true;
      if (!waitUntilPending) {
        worker.removeListener("error", onErr);
        worker.removeListener("message", onMsg);
      } else {
        waitUntilTimeout = setTimeout(() => {
          worker.removeAllListeners("message");
          worker.removeListener("error", onErr);
          clearCancellationState();
          console.error("[Pool] EdgeRuntime.waitUntil timed out; replacing worker");
          this.replaceWorker(worker);
        }, WAIT_UNTIL_TIMEOUT_MS);
      }

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
        if (waitUntilPending) {
          worker.removeListener("message", onMsg);
          const waitUntilListener = (waitMsg: any) => {
            if (waitMsg.type === "log" && opts.onLog && waitMsg.timestamp && waitMsg.stream && waitMsg.level && waitMsg.message) {
              opts.onLog({
                timestamp: waitMsg.timestamp,
                stream: waitMsg.stream,
                level: waitMsg.level,
                message: waitMsg.message,
              });
              return;
            }
            if (waitMsg.type !== "wait_until_done") return;
            if (waitUntilTimeout) clearTimeout(waitUntilTimeout);
            worker.removeListener("message", waitUntilListener);
            worker.removeListener("error", onErr);
            this.recycle(worker);
          };
          worker.on("message", waitUntilListener);
        } else {
          this.recycle(worker);
        }
      }
    };

    const onErr = (err: Error) => {
      clearTimeout(timeout);
      if (waitUntilTimeout) clearTimeout(waitUntilTimeout);
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
    this.totalWorkerReplacements++;
    const metadata = this.workerMetadata.get(dead);
    if (metadata?.replacementTimer) clearTimeout(metadata.replacementTimer);
    this.workerMetadata.delete(dead);
    const idleIdx = this.idle.indexOf(dead);
    if (idleIdx !== -1) this.idle.splice(idleIdx, 1);
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
    const snapshot = this.snapshotMetrics();
    return Object.entries(snapshot)
      .map(([key, value]) => `${key} ${value}`)
      .join("\n");
  }

  private recordModuleCacheStats(msg: { moduleCacheHit?: boolean; moduleCacheSize?: number }) {
    if (msg.moduleCacheHit === true) {
      this.totalModuleCacheHits++;
    } else if (msg.moduleCacheHit === false) {
      this.totalModuleCacheMisses++;
    }
    if (typeof msg.moduleCacheSize === "number") {
      this.lastModuleCacheEntries = msg.moduleCacheSize;
    }
  }

  private sendControlMessage(
    worker: Worker,
    message: WorkerControlMessage,
  ): Promise<WorkerControlAck> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        worker.removeListener("message", onMsg);
        resolve({ acked: false, invalidated: 0, moduleCacheSize: this.lastModuleCacheEntries });
      }, CONTROL_MESSAGE_TIMEOUT_MS);

      const onMsg = (msg: {
        type?: string;
        functionId?: string;
        projectRef?: string;
        invalidated?: number;
        moduleCacheSize?: number;
      }) => {
        if (msg.type !== "invalidate_done") return;
        if (message.type === "invalidate_module" && msg.functionId !== message.functionId) return;
        if (message.type === "invalidate_project" && msg.projectRef !== message.projectRef) return;
        clearTimeout(timeout);
        worker.removeListener("message", onMsg);
        resolve({
          acked: true,
          invalidated: typeof msg.invalidated === "number" ? msg.invalidated : 0,
          moduleCacheSize: typeof msg.moduleCacheSize === "number" ? msg.moduleCacheSize : this.lastModuleCacheEntries,
        });
      };

      worker.on("message", onMsg);
      try {
        worker.postMessage(message);
      } catch {
        clearTimeout(timeout);
        worker.removeListener("message", onMsg);
        resolve({ acked: false, invalidated: 0, moduleCacheSize: this.lastModuleCacheEntries });
      }
    });
  }

  private async invalidateWorkers(message: WorkerControlMessage): Promise<WorkerPoolControlResult> {
    this.totalInvalidations++;
    const workers = [...this.activeWorkers];
    const results = await Promise.all(
      workers.map(async (worker) => ({
        worker,
        result: await this.sendControlMessage(worker, message),
      })),
    );
    for (const { worker, result } of results) {
      if (result.acked) continue;
      if (this.idle.includes(worker)) {
        this.replaceWorker(worker);
      } else {
        this.tainted.add(worker);
      }
    }
    const invalidated = results.reduce((sum, item) => sum + item.result.invalidated, 0);
    const latestSize = results.at(-1)?.result.moduleCacheSize;
    if (typeof latestSize === "number") {
      this.lastModuleCacheEntries = latestSize;
    }
    this.totalModuleCacheInvalidated += invalidated;
    return {
      attempted: workers.length,
      succeeded: results.filter((item) => item.result.acked).length,
      invalidated,
    };
  }

  invalidateModule(functionId: string): Promise<WorkerPoolControlResult> {
    console.log(`[Pool] Invalidating module: ${functionId}`);
    return this.invalidateWorkers({ type: "invalidate_module", functionId });
  }

  invalidateProject(projectRef: string): Promise<WorkerPoolControlResult> {
    console.log(`[Pool] Invalidating project modules: ${projectRef}`);
    return this.invalidateWorkers({ type: "invalidate_project", projectRef });
  }

  private async preheatWorker(
    worker: Worker,
    functionId: string,
    functionPath: string,
    projectRoot: string,
    env: Record<string, string>,
    options: PreheatOptions = {},
  ): Promise<WorkerPreheatResult> {
    const tlsPolicy = await this.resolveTlsPolicy(env);
    const projectRef = options.projectRef ?? extractProjectRef(functionId);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        worker.removeListener("message", onMsg);
        resolve({ success: false, cacheHit: null, moduleCacheSize: this.lastModuleCacheEntries });
      }, 10000);

      const onMsg = (msg: {
        type?: string;
        functionId?: string;
        moduleCacheHit?: boolean;
        moduleCacheSize?: number;
      }) => {
        if (msg.type === "preheat_done" && msg.functionId === functionId) {
          clearTimeout(timeout);
          worker.removeListener("message", onMsg);
          this.recordModuleCacheStats(msg);
          resolve({
            success: true,
            cacheHit: typeof msg.moduleCacheHit === "boolean" ? msg.moduleCacheHit : null,
            moduleCacheSize: typeof msg.moduleCacheSize === "number" ? msg.moduleCacheSize : this.lastModuleCacheEntries,
          });
        } else if (
          msg.type === "preheat_error" &&
          msg.functionId === functionId
        ) {
          clearTimeout(timeout);
          worker.removeListener("message", onMsg);
          resolve({ success: false, cacheHit: null, moduleCacheSize: this.lastModuleCacheEntries });
        }
      };

      worker.on("message", onMsg);
      worker.postMessage({
        type: "preheat",
        functionId,
        functionPath,
        projectRoot,
        projectRef,
        moduleVersion: options.moduleVersion,
        env,
        tlsPolicy,
      });
    });
  }

  preheat(
    functionId: string,
    functionPath: string,
    projectRoot: string,
    env: Record<string, string>,
    options: PreheatOptions = {},
  ): Promise<boolean> {
    const worker = this.idle.pop();
    if (!worker) {
      return Promise.resolve(false);
    }

    return this.preheatWorker(worker, functionId, functionPath, projectRoot, env, options)
      .then((result) => result.success)
      .finally(() => {
        if (!this.draining && this.activeWorkers.has(worker)) {
          this.idle.push(worker);
        }
      });
  }

  async preheatIdleWorkers(
    functionId: string,
    functionPath: string,
    projectRoot: string,
    env: Record<string, string>,
    options: PreheatOptions = {},
  ): Promise<WorkerPoolPreheatResult> {
    const start = performance.now();
    const requested = options.maxWorkers && options.maxWorkers > 0
      ? Math.min(options.maxWorkers, this.idle.length)
      : this.idle.length;
    const workers = this.idle.splice(0, requested);
    if (workers.length === 0) {
      return { attempted: 0, succeeded: 0, cacheHits: 0, cacheMisses: 0, durationMs: 0 };
    }

    try {
      const results = await Promise.all(
        workers.map((worker) => this.preheatWorker(worker, functionId, functionPath, projectRoot, env, options)),
      );
      const durationMs = Math.round(performance.now() - start);
      this.totalPreheatAttempts += workers.length;
      this.totalPreheatSucceeded += results.filter((result) => result.success).length;
      this.totalPreheatMs += durationMs;
      return {
        attempted: workers.length,
        succeeded: results.filter((result) => result.success).length,
        cacheHits: results.filter((result) => result.cacheHit === true).length,
        cacheMisses: results.filter((result) => result.cacheHit === false).length,
        durationMs,
      };
    } finally {
      if (!this.draining) {
        this.idle.push(...workers.filter((worker) => this.activeWorkers.has(worker)));
      }
    }
  }

  snapshotMetrics(prefix = "supacloud_edge"): Record<string, number> {
    return {
      [`${prefix}_active_workers`]: this.config.size - this.idle.length,
      [`${prefix}_idle_workers`]: this.idle.length,
      [`${prefix}_worker_smol`]: this.config.smol ? 1 : 0,
      [`${prefix}_queue_length`]: this.queue.length,
      [`${prefix}_total_requests`]: this.totalRequests,
      [`${prefix}_total_invalidations`]: this.totalInvalidations,
      [`${prefix}_tainted_workers`]: this.tainted.size,
      [`${prefix}_total_env_load_ms`]: this.totalEnvLoadMs,
      [`${prefix}_total_queue_wait_ms`]: this.totalQueueWaitMs,
      [`${prefix}_total_worker_exec_ms`]: this.totalWorkerExecMs,
      [`${prefix}_total_module_cache_hits`]: this.totalModuleCacheHits,
      [`${prefix}_total_module_cache_misses`]: this.totalModuleCacheMisses,
      [`${prefix}_total_module_cache_invalidated`]: this.totalModuleCacheInvalidated,
      [`${prefix}_module_cache_entries_last_worker`]: this.lastModuleCacheEntries,
      [`${prefix}_total_worker_replacements`]: this.totalWorkerReplacements,
      [`${prefix}_total_preheat_attempts`]: this.totalPreheatAttempts,
      [`${prefix}_total_preheat_succeeded`]: this.totalPreheatSucceeded,
      [`${prefix}_total_preheat_ms`]: this.totalPreheatMs,
      [`${prefix}_avg_env_load_ms`]: this.totalRequests > 0 ? Math.round(this.totalEnvLoadMs / this.totalRequests) : 0,
      [`${prefix}_avg_queue_wait_ms`]: this.totalRequests > 0 ? Math.round(this.totalQueueWaitMs / this.totalRequests) : 0,
      [`${prefix}_total_queued_requests`]: this.totalQueueWaitMs > 0 ? this.totalRequests : 0,
      [`${prefix}_avg_worker_exec_ms`]: this.totalRequests > 0 ? Math.round(this.totalWorkerExecMs / this.totalRequests) : 0,
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
