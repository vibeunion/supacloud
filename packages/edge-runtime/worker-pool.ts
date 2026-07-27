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
  signal?: AbortSignal;
  envLoadMs?: number;
  onLog?: (entry: {
    timestamp: string;
    stream: "stdout" | "stderr";
    level: string;
    message: string;
  }) => void;
}

type ScheduledDispatch = DispatchOptions & {
  executionKey: string;
};

type QueuedDispatch = {
  opts: ScheduledDispatch;
  enqueuedAt: number;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
};

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
const DEFAULT_MAX_RETIREMENT_AGE_MS = 60_000;
const DEFAULT_PREHEAT_TIMEOUT_MS = 10_000;

function cancelledResponse(): Response {
  return new Response(JSON.stringify({ error: "Task cancelled" }), {
    status: 499,
    headers: { "Content-Type": "application/json" },
  });
}

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

type RetirementBudgetExceeded = {
  limit: "count" | "age";
  retiredWorkers: number;
  oldestRetirementAgeMs: number;
};

type WorkerPoolConfig = {
  size: number;
  requestTimeout: number;
  smol?: boolean;
  preheatTimeoutMs?: number;
  retirementBudget?: {
    maxRetiredWorkers: number;
    maxRetirementAgeMs: number;
  };
  onRetirementBudgetExceeded?: (exceeded: RetirementBudgetExceeded) => void;
};

type RetiredWorker = {
  retiredAt: number;
  ageTimer: ReturnType<typeof setTimeout>;
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
  // Keep each project FIFO while rotating projects through the shared pool.
  private queuedDispatches = new Map<string, QueuedDispatch[]>();
  private queuedProjects: string[] = [];
  private queuedCount = 0;
  private lastDispatchedProjectRef: string | null = null;
  private inFlight = new Map<string, { cancel: () => void; cancelKey?: string }>();
  private totalRequests = 0;
  private totalInvalidations = 0;
  private totalEnvLoadMs = 0;
  private totalQueueWaitMs = 0;
  private totalQueuedRequests = 0;
  private totalWorkerExecMs = 0;
  private totalModuleCacheHits = 0;
  private totalModuleCacheMisses = 0;
  private totalModuleCacheInvalidated = 0;
  private lastModuleCacheEntries = 0;
  private totalWorkerReplacements = 0;
  private totalPreheatAttempts = 0;
  private totalPreheatSucceeded = 0;
  private totalPreheatMs = 0;
  private totalWorkerRetirements = 0;
  private totalNaturalWorkerExits = 0;
  private retirementBudgetExceeded = false;
  private activeWorkers = new Set<Worker>();
  private retiredWorkers = new Map<Worker, RetiredWorker>();
  private workerMetadata = new Map<
    Worker,
    {
      replacementTimer?: ReturnType<typeof setTimeout>;
      isCancelling?: boolean;
    }
  >();
  private tainted = new Set<Worker>();
  private draining = false;

  private readonly retirementBudget: {
    maxRetiredWorkers: number;
    maxRetirementAgeMs: number;
  };
  private readonly onRetirementBudgetExceeded: (exceeded: RetirementBudgetExceeded) => void;

  constructor(private config: WorkerPoolConfig) {
    this.retirementBudget = config.retirementBudget ?? {
      maxRetiredWorkers: Math.max(config.size * 2, 8),
      maxRetirementAgeMs: DEFAULT_MAX_RETIREMENT_AGE_MS,
    };
    this.onRetirementBudgetExceeded = config.onRetirementBudgetExceeded ?? ((exceeded) => {
      console.error("[Pool] Worker retirement budget exceeded; restarting Edge Runtime", exceeded);
      process.exit(1);
    });
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
    w.once("exit", () => this.onWorkerExit(w));
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
    const executionKey = crypto.randomUUID();
    const signal = opts.signal ?? opts.request.signal;
    if (signal.aborted) return cancelledResponse();

    const responsePromise = this.enqueue({ ...opts, executionKey });
    const cancelDispatch = () => {
      this.cancelExecution(executionKey);
    };
    signal.addEventListener("abort", cancelDispatch, { once: true });
    if (signal.aborted) cancelDispatch();

    try {
      return await responsePromise;
    } finally {
      signal.removeEventListener("abort", cancelDispatch);
    }
  }

  private enqueue(opts: ScheduledDispatch): Promise<Response> {
    const enqueuedAt = performance.now();
    return new Promise<Response>((resolve, reject) => {
      if (this.queuedCount >= MAX_QUEUE_SIZE) {
        resolve(new Response(JSON.stringify({ error: "Too many concurrent requests, please retry" }), {
          status: 503,
          headers: { "Content-Type": "application/json", "Retry-After": "5" },
        }));
        return;
      }

      const worker = this.idle.pop();
      if (worker) {
        this.lastDispatchedProjectRef = this.projectKey(opts);
        this.execute(worker, opts, enqueuedAt, resolve).catch(reject);
      } else {
        this.totalQueuedRequests++;
        this.enqueueQueued({ opts, enqueuedAt, resolve, reject });
      }
    });
  }

  private projectKey(opts: DispatchOptions): string {
    return opts.projectRef ?? extractProjectRef(opts.functionId) ?? opts.functionId;
  }

  private enqueueQueued(entry: QueuedDispatch): void {
    const projectRef = this.projectKey(entry.opts);
    const projectQueue = this.queuedDispatches.get(projectRef);
    if (projectQueue) {
      projectQueue.push(entry);
    } else {
      this.queuedDispatches.set(projectRef, [entry]);
      this.queuedProjects.push(projectRef);
    }
    this.queuedCount++;
  }

  private dequeueQueued(): QueuedDispatch | null {
    if (this.queuedCount === 0) return null;

    const preferredIndex = this.queuedProjects.findIndex(
      (projectRef) => projectRef !== this.lastDispatchedProjectRef,
    );
    const projectIndex = preferredIndex >= 0 ? preferredIndex : 0;
    const [projectRef] = this.queuedProjects.splice(projectIndex, 1);
    const projectQueue = this.queuedDispatches.get(projectRef);
    if (!projectQueue) throw new Error(`Missing dispatch queue for project ${projectRef}`);
    const entry = projectQueue.shift();
    if (!entry) throw new Error(`Empty dispatch queue for project ${projectRef}`);

    this.queuedCount--;
    if (projectQueue.length > 0) {
      this.queuedProjects.push(projectRef);
    } else {
      this.queuedDispatches.delete(projectRef);
    }
    this.lastDispatchedProjectRef = projectRef;
    return entry;
  }

  private async execute(
    worker: Worker,
    opts: ScheduledDispatch,
    enqueuedAt: number,
    resolve: (r: Response) => void,
  ) {
    const queueWaitMs = Math.round(performance.now() - enqueuedAt);
    this.totalQueueWaitMs += queueWaitMs;
    const cancelGraceMs = 3_000;

    let resolved = false;
    const safeResolve = (r: Response) => {
      if (resolved) return;
      resolved = true;
      resolve(r);
    };
    const cleanupInFlight = () => {
      this.inFlight.delete(opts.executionKey);
    };
    const metadata = this.workerMetadata.get(worker) || {};
    metadata.isCancelling = false;
    if (metadata.replacementTimer) {
      clearTimeout(metadata.replacementTimer);
      metadata.replacementTimer = undefined;
    }
    this.workerMetadata.set(worker, metadata);
    const clearCancellationState = () => {
      const current = this.workerMetadata.get(worker);
      if (!current) return;
      current.isCancelling = false;
      if (current.replacementTimer) {
        clearTimeout(current.replacementTimer);
        current.replacementTimer = undefined;
      }
    };

    let executionStarted = false;
    let cancellationRequested = false;
    let detachResponseListeners = () => {};

    const timeout = setTimeout(() => {
      detachResponseListeners();
      cleanupInFlight();
      clearCancellationState();
      safeResolve(new Response("Gateway Timeout", { status: 504 }));
      this.retireWorker(worker);
    }, this.config.requestTimeout);

    const replaceCancelledWorker = () => {
      detachResponseListeners();
      cleanupInFlight();
      clearCancellationState();
      safeResolve(cancelledResponse());
      this.retireWorker(worker);
    };

    const cancelExecution = () => {
      cancellationRequested = true;
      if (!executionStarted) return;
      const current = this.workerMetadata.get(worker);
      if (!current || current.isCancelling) return;
      current.isCancelling = true;
      clearTimeout(timeout);
      try {
        worker.postMessage({ type: "cancel_current" });
      } catch (error) {
        console.warn("[Pool] Failed to signal worker cancellation; replacing worker", error);
        replaceCancelledWorker();
        return;
      }
      current.replacementTimer = setTimeout(replaceCancelledWorker, cancelGraceMs);
    };

    this.inFlight.set(opts.executionKey, {
      cancel: cancelExecution,
      cancelKey: opts.cancelKey,
    });

    const releaseBeforeExecution = () => {
      clearTimeout(timeout);
      cleanupInFlight();
      clearCancellationState();
      this.recycle(worker);
    };

    const finishCancelledBeforeExecution = () => {
      if (resolved) return true;
      if (!cancellationRequested) return false;
      releaseBeforeExecution();
      safeResolve(cancelledResponse());
      return true;
    };

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
        releaseBeforeExecution();
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
        return;
      }
      try {
        body = await opts.request.arrayBuffer();
      } catch (error) {
        if (finishCancelledBeforeExecution()) return;
        releaseBeforeExecution();
        throw error;
      }
      if (finishCancelledBeforeExecution()) return;
      if (body.byteLength > MAX_BODY_SIZE) {
        releaseBeforeExecution();
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
        return;
      }
    }

    const execStart = performance.now();
    let tlsPolicy: EdgeFetchTlsPolicy;
    try {
      tlsPolicy = await this.resolveTlsPolicy(opts.env);
    } catch (error) {
      if (finishCancelledBeforeExecution()) return;
      releaseBeforeExecution();
      throw error;
    }
    if (finishCancelledBeforeExecution()) return;

    let waitUntilTimeout: ReturnType<typeof setTimeout> | undefined;
    let failActiveStream: ((error: Error) => void) | undefined;

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
      const waitUntilPending = msg.waitUntilPending === true;
      const streamPending = msg.type === "stream_start" && !!msg.streamId;
      if (!waitUntilPending && !streamPending) {
        cleanupInFlight();
        clearCancellationState();
        worker.removeListener("error", onErr);
        worker.removeListener("message", onMsg);
      } else if (waitUntilPending) {
        waitUntilTimeout = setTimeout(() => {
          worker.removeAllListeners("message");
          worker.removeListener("error", onErr);
          cleanupInFlight();
          clearCancellationState();
          console.error("[Pool] EdgeRuntime.waitUntil timed out; replacing worker");
          this.retireWorker(worker);
        }, WAIT_UNTIL_TIMEOUT_MS);
      } else {
        worker.removeListener("message", onMsg);
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
        let streamFinished = false;
        let streamListener: ((streamMsg: any) => void) | undefined;
        const clearStreamState = () => {
          streamFinished = true;
          if (streamListener) worker.removeListener("message", streamListener);
          worker.removeListener("error", onErr);
          cleanupInFlight();
          clearCancellationState();
          failActiveStream = undefined;
        };
        const completeStream = () => {
          if (streamFinished) return;
          clearStreamState();
          this.recycle(worker);
        };
        const abandonStream = () => {
          if (streamFinished) return;
          clearStreamState();
          this.retireWorker(worker);
        };

        const bodyStream = new ReadableStream<Uint8Array>({
          start(controller) {
            failActiveStream = (error) => {
              controller.error(error);
              abandonStream();
            };
            streamListener = (streamMsg: any) => {
              if (streamMsg.type === "stream_chunk" && streamMsg.streamId === streamId) {
                if (streamMsg.done) {
                  if (streamMsg.error) {
                    controller.error(new Error(streamMsg.error));
                  } else {
                    controller.close();
                  }
                  completeStream();
                } else if (streamMsg.chunk) {
                  controller.enqueue(new Uint8Array(streamMsg.chunk));
                }
              }
            };
            worker.on("message", streamListener);
          },
          cancel() {
            abandonStream();
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
            cleanupInFlight();
            clearCancellationState();
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
      console.error("[Pool] Worker error:", err);
      if (failActiveStream) {
        failActiveStream(err);
        return;
      }
      cleanupInFlight();
      clearCancellationState();
      detachResponseListeners();
      safeResolve(new Response("Internal Error", { status: 500 }));
      this.retireWorker(worker);
    };

    detachResponseListeners = () => {
      worker.removeListener("message", onMsg);
      worker.removeListener("error", onErr);
    };
    worker.on("message", onMsg);
    worker.once("error", onErr);
    try {
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
    } catch (error) {
      onErr(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    executionStarted = true;
    if (cancellationRequested) cancelExecution();
  }

  private recycle(worker: Worker) {
    if (!this.activeWorkers.has(worker)) return;
    const metadata = this.workerMetadata.get(worker);
    if (metadata?.replacementTimer) {
      clearTimeout(metadata.replacementTimer);
      metadata.replacementTimer = undefined;
    }
    if (metadata) {
      metadata.isCancelling = false;
    }
    if (this.tainted.has(worker)) {
      this.tainted.delete(worker);
      this.retireWorker(worker);
      return;
    }

    this.schedule(worker);
  }

  private schedule(worker: Worker) {
    const next = this.dequeueQueued();
    if (!next) {
      this.idle.push(worker);
      return;
    }
    this.execute(worker, next.opts, next.enqueuedAt, next.resolve).catch(next.reject);
  }

  private retireWorker(worker: Worker) {
    if (!this.activeWorkers.delete(worker)) return;
    this.totalWorkerRetirements++;
    const metadata = this.workerMetadata.get(worker);
    if (metadata?.replacementTimer) clearTimeout(metadata.replacementTimer);
    this.workerMetadata.delete(worker);
    this.tainted.delete(worker);
    const idleIdx = this.idle.indexOf(worker);
    if (idleIdx !== -1) this.idle.splice(idleIdx, 1);
    this.trackRetiredWorker(worker);

    try {
      worker.postMessage({ type: "retire" });
    } catch (error) {
      console.warn("[Pool] Failed to signal cooperative worker retirement", error);
    }
    worker.unref();

    if (!this.draining) {
      this.totalWorkerReplacements++;
      const replacement = this.createWorker();
      this.activeWorkers.add(replacement);
      this.schedule(replacement);
    }
  }

  private trackRetiredWorker(worker: Worker) {
    const retiredAt = Date.now();
    const ageTimer = setTimeout(() => {
      if (!this.retiredWorkers.has(worker)) return;
      this.triggerRetirementFailSafe("age");
    }, this.retirementBudget.maxRetirementAgeMs);
    this.retiredWorkers.set(worker, { retiredAt, ageTimer });
    if (this.retiredWorkers.size > this.retirementBudget.maxRetiredWorkers) {
      this.triggerRetirementFailSafe("count");
    }
  }

  private onWorkerExit(worker: Worker) {
    const retired = this.retiredWorkers.get(worker);
    if (retired) {
      clearTimeout(retired.ageTimer);
      this.retiredWorkers.delete(worker);
      this.totalNaturalWorkerExits++;
    }

    this.removeWorkerReferences(worker);
    if (!this.activeWorkers.delete(worker) || this.draining) return;

    this.totalWorkerReplacements++;
    const replacement = this.createWorker();
    this.activeWorkers.add(replacement);
    this.schedule(replacement);
  }

  private removeWorkerReferences(worker: Worker) {
    this.workerMetadata.delete(worker);
    this.tainted.delete(worker);
    const idleIndex = this.idle.indexOf(worker);
    if (idleIndex !== -1) this.idle.splice(idleIndex, 1);
    const workerIndex = this.workers.indexOf(worker);
    if (workerIndex !== -1) this.workers.splice(workerIndex, 1);
  }

  private triggerRetirementFailSafe(limit: "count" | "age") {
    if (this.retirementBudgetExceeded) return;
    this.retirementBudgetExceeded = true;
    this.stopDispatching();
    this.onRetirementBudgetExceeded({
      limit,
      retiredWorkers: this.retiredWorkers.size,
      oldestRetirementAgeMs: this.oldestRetirementAgeMs(),
    });
  }

  private oldestRetirementAgeMs(): number {
    let oldestRetiredAt = Date.now();
    for (const retired of this.retiredWorkers.values()) {
      oldestRetiredAt = Math.min(oldestRetiredAt, retired.retiredAt);
    }
    return this.retiredWorkers.size === 0 ? 0 : Date.now() - oldestRetiredAt;
  }

  private stopDispatching() {
    this.draining = true;
    for (const projectQueue of this.queuedDispatches.values()) {
      for (const entry of projectQueue) {
        entry.resolve(new Response(JSON.stringify({ error: "Server shutting down" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }));
      }
    }
    this.queuedDispatches.clear();
    this.queuedProjects = [];
    this.queuedCount = 0;
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
        this.retireWorker(worker);
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
        this.retireWorker(worker);
        resolve({ success: false, cacheHit: null, moduleCacheSize: this.lastModuleCacheEntries });
      }, this.config.preheatTimeoutMs ?? DEFAULT_PREHEAT_TIMEOUT_MS);

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
      try {
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
      } catch (error) {
        clearTimeout(timeout);
        worker.removeListener("message", onMsg);
        console.warn("[Pool] Failed to dispatch worker preheat", error);
        this.retireWorker(worker);
        resolve({ success: false, cacheHit: null, moduleCacheSize: this.lastModuleCacheEntries });
      }
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
          this.schedule(worker);
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
        for (const worker of workers) {
          if (this.activeWorkers.has(worker)) this.schedule(worker);
        }
      }
    }
  }

  snapshotMetrics(prefix = "supacloud_edge"): Record<string, number> {
    return {
      [`${prefix}_active_workers`]: this.config.size - this.idle.length,
      [`${prefix}_idle_workers`]: this.idle.length,
      [`${prefix}_worker_smol`]: this.config.smol ? 1 : 0,
      [`${prefix}_queue_length`]: this.queuedCount,
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
      [`${prefix}_retired_workers`]: this.retiredWorkers.size,
      [`${prefix}_total_worker_retirements`]: this.totalWorkerRetirements,
      [`${prefix}_total_natural_worker_exits`]: this.totalNaturalWorkerExits,
      [`${prefix}_oldest_retired_worker_age_ms`]: this.oldestRetirementAgeMs(),
      [`${prefix}_retirement_budget_exceeded`]: this.retirementBudgetExceeded ? 1 : 0,
      [`${prefix}_total_preheat_attempts`]: this.totalPreheatAttempts,
      [`${prefix}_total_preheat_succeeded`]: this.totalPreheatSucceeded,
      [`${prefix}_total_preheat_ms`]: this.totalPreheatMs,
      [`${prefix}_avg_env_load_ms`]: this.totalRequests > 0 ? Math.round(this.totalEnvLoadMs / this.totalRequests) : 0,
      [`${prefix}_avg_queue_wait_ms`]: this.totalRequests > 0 ? Math.round(this.totalQueueWaitMs / this.totalRequests) : 0,
      [`${prefix}_total_queued_requests`]: this.totalQueuedRequests,
      [`${prefix}_avg_worker_exec_ms`]: this.totalRequests > 0 ? Math.round(this.totalWorkerExecMs / this.totalRequests) : 0,
    };
  }

  cancel(cancelKey: string): boolean {
    const queued = this.findQueued((entry) => entry.opts.cancelKey === cancelKey);
    if (queued) return this.cancelQueued(queued.projectRef, queued.index);

    const inFlight = [...this.inFlight.values()]
      .find((execution) => execution.cancelKey === cancelKey);
    if (!inFlight) return false;
    inFlight.cancel();
    return true;
  }

  private cancelExecution(executionKey: string): boolean {
    const queued = this.findQueued((entry) => entry.opts.executionKey === executionKey);
    if (queued) return this.cancelQueued(queued.projectRef, queued.index);

    const inFlight = this.inFlight.get(executionKey);
    if (!inFlight) return false;
    inFlight.cancel();
    return true;
  }

  private findQueued(
    predicate: (entry: QueuedDispatch) => boolean,
  ): { projectRef: string; index: number } | null {
    for (const [projectRef, projectQueue] of this.queuedDispatches) {
      const index = projectQueue.findIndex(predicate);
      if (index >= 0) return { projectRef, index };
    }
    return null;
  }

  private cancelQueued(projectRef: string, queuedIndex: number): boolean {
    const projectQueue = this.queuedDispatches.get(projectRef);
    if (!projectQueue) return false;
    const [queued] = projectQueue.splice(queuedIndex, 1);
    if (!queued) return false;
    this.queuedCount--;
    if (projectQueue.length === 0) {
      this.queuedDispatches.delete(projectRef);
      this.queuedProjects = this.queuedProjects.filter((queuedProject) => queuedProject !== projectRef);
    }
    queued.resolve(cancelledResponse());
    return true;
  }

  get activeCount(): number {
    return this.inFlight.size;
  }

  drain(): Promise<void> {
    this.stopDispatching();

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

  async shutdown(): Promise<void> {
    const maxDrainMs = Math.min(this.config.requestTimeout + 100, 5_000);
    const drained = await Promise.race([
      this.drain().then(() => true),
      Bun.sleep(maxDrainMs).then(() => false),
    ]);
    if (!drained) {
      console.error(`[Pool] Cooperative shutdown drain exceeded ${maxDrainMs}ms`);
    }
    for (const worker of [...this.activeWorkers]) {
      this.retireWorker(worker);
    }
    await Bun.sleep(0);
  }
}
