import { receiveBufferedResponse } from "./response-buffer";
import {
  BODY_CHUNK_BYTES, BodyBufferBudget, BodyLimitError, BufferBudgetError,
  bodyBufferBudget, bufferedBody, positiveBytes, readBoundedBody, responseBufferBudget,
} from "./body-transfer";
import { Worker, type WorkerOptions, type MessagePort } from "worker_threads";
import { functionBytecodeCache } from "./function-bytecode";
import type { FunctionBytecodeArtifact } from "./function-bytecode-contract";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { resolveEdgeFetchTlsPolicy } from "./fetch-tls-policy";
import type { EdgeFetchTlsPolicy } from "./fetch-tls-policy";
import type { PgredisRuntimeBindingConfig } from "./internal-bindings";
import { EMBEDDED_WORKER_HASH, EMBEDDED_WORKER_SOURCE } from "./generated/embedded-worker";
import { assertCanonicalPositiveFunctionVersion } from "./function-version";
import {
  isEdgeRuntimePreheatAttestation,
  preheatAttestationMatches,
  type EdgeRuntimePreheatAttestation,
  type EdgeRuntimePreheatIdentity,
} from "./preheat-attestation";

interface DispatchOptions {
  functionId: string;
  functionPath: string;
  projectRoot: string;
  projectRef: string;
  framework?: "fetch" | "elysia" | "hono" | "sveltekit-function";
  capabilities?: {
    secrets?: string[];
    outbound_hosts?: string[];
    bindings?: string[];
    background?: boolean;
  };
  limits?: {
    timeout_ms?: number;
    max_request_body_bytes?: number;
    max_response_body_bytes?: number;
    wait_until_timeout_ms?: number;
  };
  functionVersion?: string | null;
  moduleVersion?: string;
  envProof?: string;
  artifactSha256?: string;
  bytecode?: "off" | "auto" | "required";
  env: Record<string, string>;
  internalBindings?: Omit<PgredisRuntimeBindingConfig, "signal">;
  request: Request;
  cancelKey?: string;
  signal?: AbortSignal;
  envLoadMs?: number;
  onExecutionStarted?: () => void;
  onLog?: (entry: {
    timestamp: string;
    stream: "stdout" | "stderr";
    level: string;
    message: string;
  }) => void;
}

type ScheduledDispatch = DispatchOptions & {
  executionKey: string;
  releaseQueueReservation: () => void;
};

type QueuedDispatch = {
  opts: ScheduledDispatch;
  enqueuedAt: number;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
};

const DEFAULT_MAX_BODY_SIZE_MB = 30;
const FUNCTION_VERSION_HEADER = "x-supacloud-function-version";

export function resolveMaxBodySizeBytes(value = process.env.EDGE_MAX_BODY_SIZE_MB): number {
  const configuredMb = Number(value);
  const maxBodySizeMb = Number.isFinite(configuredMb) && configuredMb > 0
    ? configuredMb
    : DEFAULT_MAX_BODY_SIZE_MB;
  return maxBodySizeMb * 1024 * 1024;
}

export function resolveMaxHttpBodySizeBytes(value = process.env.EDGE_MAX_BODY_SIZE_MB): number {
  return Math.max(128 * 1024 * 1024, resolveMaxBodySizeBytes(value));
}

function formatBodyLimit(bytes: number): string {
  return bytes % (1024 * 1024) === 0
    ? `${bytes / (1024 * 1024)}MB`
    : `${bytes} bytes`;
}

const MAX_BODY_SIZE = resolveMaxBodySizeBytes();
const MAX_QUEUE_SIZE = Number(process.env.MAX_QUEUE_SIZE) || 200;
const WAIT_UNTIL_TIMEOUT_MS = Number(process.env.EDGE_WAIT_UNTIL_TIMEOUT_MS) || 300_000;
const CONTROL_MESSAGE_TIMEOUT_MS = Number(process.env.EDGE_CONTROL_MESSAGE_TIMEOUT_MS) || 1_000;
const DEFAULT_MAX_RETIREMENT_AGE_MS = 60_000;
const DEFAULT_PREHEAT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_EXTRA_PROJECT_WORKERS = 2;
const DEFAULT_PARKED_WORKER_IDLE_MS = 30_000;
const SURPLUS_WORKER_IDLE_MS = 1_000;
// Bun/JSC retains fixed host memory after Worker exit, so bound churn before recycling the process.
const DEFAULT_MAX_WORKER_REPLACEMENTS_BEFORE_RECYCLE = 128;
const MAX_WORKER_REPLACEMENTS_ENV = "EDGE_MAX_WORKER_REPLACEMENTS_BEFORE_RECYCLE";

export function resolveWorkerReplacementBudget(rawBudget?: string): number | undefined {
  if (rawBudget === undefined || rawBudget === "") return undefined;
  if (!/^[1-9]\d*$/.test(rawBudget)) {
    throw new Error(`${MAX_WORKER_REPLACEMENTS_ENV} must be a positive integer`);
  }
  const parsedBudget = Number(rawBudget);
  if (!Number.isSafeInteger(parsedBudget)) {
    throw new Error(`${MAX_WORKER_REPLACEMENTS_ENV} must be a safe integer`);
  }
  return parsedBudget;
}

export function resolveProjectWorkerCacheOptions(env: Record<string, string | undefined>): {
  maxExtraProjectWorkers?: number;
  parkedWorkerIdleMs?: number;
} {
  const parse = (key: string): number | undefined => {
    const raw = env[key];
    if (raw === undefined || raw === "") return undefined;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)) {
      throw new Error(`${key} must be a non-negative safe integer`);
    }
    return value;
  };
  return {
    maxExtraProjectWorkers: parse("EDGE_MAX_EXTRA_PROJECT_WORKERS"),
    parkedWorkerIdleMs: parse("EDGE_PARKED_WORKER_IDLE_MS"),
  };
}

/**
 * Resolves how many Function invocations may run at once in one runtime process.
 *
 * Extra workers can overlap I/O, but each retains its own heap. Expansion is
 * opt-in so a memory-sized warm pool remains the default capacity budget.
 * `EDGE_MAX_FUNCTION_CONCURRENCY` is a hard upper bound;
 * values below the warm pool size are rejected because they would disable slots
 * that already exist.
 */
export function resolveMaxConcurrentExecutions(
  size: number,
  env: Record<string, string | undefined>,
): number {
  const raw = env.EDGE_MAX_FUNCTION_CONCURRENCY;
  if (raw === undefined || raw.trim() === "") {
    return size;
  }
  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value)) {
    throw new Error("EDGE_MAX_FUNCTION_CONCURRENCY must be a non-negative safe integer");
  }
  if (value < size) {
    throw new Error("EDGE_MAX_FUNCTION_CONCURRENCY must be at least WORKER_POOL_SIZE");
  }
  return value;
}

function cancelledResponse(): Response {
  return new Response(JSON.stringify({ error: "Task cancelled" }), {
    status: 499,
    headers: { "Content-Type": "application/json" },
  });
}

function admissionBlockedResponse(): Response {
  return new Response(JSON.stringify({
    error: "Runtime is temporarily overloaded; please retry",
  }), {
    status: 503,
    headers: { "Content-Type": "application/json", "Retry-After": "2" },
  });
}

function invalidatedBeforeExecutionResponse(): Response {
  return new Response(JSON.stringify({
    error: "Runtime environment changed before execution",
    code: "RUNTIME_ENV_INVALIDATED",
  }), {
    status: 503,
    headers: { "Content-Type": "application/json", "Retry-After": "1" },
  });
}

function withRuntimeFunctionVersion(
  response: Response,
  version: string | null | undefined,
): Response {
  const headers = new Headers(response.headers);
  if (version === null || version === undefined) {
    headers.delete(FUNCTION_VERSION_HEADER);
  } else {
    headers.set(FUNCTION_VERSION_HEADER, version);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

type WorkerExecutionHandlers = {
  onMessage(message: WorkerResponseMessage): void;
  onError(error: Error): void;
  onExit(): void;
};

type WorkerResponseMessage = {
  type?: string; status?: number; headers?: Record<string, string | string[]>;
  body?: ArrayBuffer | null; port?: MessagePort; moduleCacheHit?: boolean;
  moduleCacheSize?: number; timestamp?: string; stream?: "stdout" | "stderr";
  level?: string; message?: string; heapSize?: number; heapCapacity?: number;
  extraMemorySize?: number; importedModuleBytes?: number; importedModuleCount?: number; waitUntilPending?: boolean;
};

type WorkerControlMessage =
  | { type: "invalidate_module"; functionId: string }
  | { type: "invalidate_project"; projectRef: string };

type WorkerPoolControlResult = {
  generation: number;
  attempted: number;
  succeeded: number;
  invalidated: number;
  cancelledQueued: number;
};

type WorkerControlAck = {
  acked: boolean;
  invalidated: number;
  moduleCacheSize: number;
};

type PreheatOptions = {
  projectRef: string;
  moduleVersion?: string;
  envProof?: string;
  attestation?: EdgeRuntimePreheatIdentity;
  bytecode?: "off" | "auto" | "required";
  bytecodeArtifact?: FunctionBytecodeArtifact;
  maxWorkers?: number;
};

type BulkPreheatRequest = {
  functionId: string;
  functionPath: string;
  projectRoot: string;
  env: Record<string, string>;
  options: PreheatOptions;
};

type WorkerPreheatRequest = BulkPreheatRequest & { worker: Worker };

type WorkerPreheatMessage = {
  type?: string;
  functionId?: string;
  heapSize?: number;
  heapCapacity?: number;
  extraMemorySize?: number;
  importedModuleBytes?: number;
  importedModuleCount?: number;
  moduleCacheHit?: boolean;
  moduleCacheSize?: number;
  attestation?: unknown;
  error?: string;
};

export type VersionedPreheatRequest = {
  functionId: string;
  functionPath: string;
  projectRoot: string;
  env: Record<string, string>;
  projectRef: string;
  moduleVersion: string;
  envProof?: string;
  attestation?: EdgeRuntimePreheatIdentity;
  bytecode?: "off" | "auto" | "required";
  maxWorkers?: number;
};

type WorkerPreheatResult = {
  success: boolean;
  cacheHit: boolean | null;
  moduleCacheSize: number;
  attestation: EdgeRuntimePreheatAttestation | null;
  error?: string;
};

export type WorkerPoolPreheatResult = {
  attempted: number;
  succeeded: number;
  cacheHits: number;
  cacheMisses: number;
  durationMs: number;
  attestation: EdgeRuntimePreheatAttestation | null;
  error?: string;
};

export type WorkerPoolGenerationRotationResult = {
  generation: number;
  attempted: number;
  idleRetired: number;
  parkedRetired: number;
  busyTainted: number;
  alreadyTainted: number;
  immediateReplacements: number;
};

export type WorkerPoolVersionPreheatResult = WorkerPoolPreheatResult & {
  rotation: WorkerPoolGenerationRotationResult;
};

type WorkerPoolRecycleRequired = {
  workerReplacements: number;
  surplusRetirements: number;
  maxWorkerReplacements: number;
};

type RetirementBudgetExceeded = {
  limit: "count" | "age";
  retiredWorkers: number;
  oldestRetirementAgeMs: number;
};

type WorkerPoolConfig = {
  size: number;
  bodyBufferBudget?: BodyBufferBudget;
  responseBufferBudget?: BodyBufferBudget;
  responseReadAheadBytes?: number;
  requestTimeout: number;
  smol?: boolean;
  preheatTimeoutMs?: number;
  retirementBudget?: {
    maxRetiredWorkers: number;
    maxRetirementAgeMs: number;
  };
  onRetirementBudgetExceeded?: (exceeded: RetirementBudgetExceeded) => void;
  maxWorkerReplacementsBeforeRecycle?: number;
  onWorkerRecycleRequired?: (event: WorkerPoolRecycleRequired) => void;
  maxExtraProjectWorkers?: number;
  parkedWorkerIdleMs?: number;
  /**
   * Upper bound on concurrently executing Function invocations. Defaults to
   * `size`, which keeps the historical queueing behaviour.
   */
  maxConcurrentExecutions?: number;
};

type RetiredWorker = {
  retiredAt: number;
  ageTimer: ReturnType<typeof setTimeout>;
};

type GenerationRotationDisposition = "idle-retired" | "parked-retired" | "busy-tainted" | "already-tainted";

function acceptedPreheatAttestation(
  candidate: unknown,
  expected: EdgeRuntimePreheatIdentity | undefined,
): EdgeRuntimePreheatAttestation | null | false {
  if (expected === undefined) return candidate === undefined ? null : false;
  if (!isEdgeRuntimePreheatAttestation(candidate)) return false;
  return preheatAttestationMatches(candidate, expected) ? candidate : false;
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
  private responseDeliveries = new Map<string, (error: Error) => void>();
  private totalRequests = 0;
  private workerMemory = new Map<Worker, { heapSize: number; heapCapacity: number; extraMemorySize: number }>();
  private memoryRetirements = 0;
  private readonly responseReadAheadBytes: number;
  private readonly maxWorkerHeap = positiveBytes(process.env.EDGE_WORKER_HEAP_BUDGET_BYTES, 128 * 1024 * 1024);
  private readonly maxModuleBytes = positiveBytes(process.env.EDGE_MODULE_BUDGET_BYTES, 32 * 1024 * 1024);
  private readonly maxModuleCount = positiveBytes(process.env.EDGE_MODULE_GENERATION_LIMIT, 100);

  private recordWorkerMemory(worker: Worker, message: {
    heapSize?: number; heapCapacity?: number; extraMemorySize?: number;
    importedModuleBytes?: number; importedModuleCount?: number;
  }) {
    this.workerMemory.set(worker, { heapSize: message.heapSize ?? 0,
      heapCapacity: message.heapCapacity ?? 0, extraMemorySize: message.extraMemorySize ?? 0 });
    if ((message.heapSize ?? 0) > this.maxWorkerHeap
      || (message.importedModuleBytes ?? 0) > this.maxModuleBytes
      || (message.importedModuleCount ?? 0) >= this.maxModuleCount) {
      this.memoryRetirements++;
      this.tainted.add(worker);
    }
  }
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
  private workerGeneration = 0;
  private totalGenerationRotations = 0;
  private totalGenerationIdleRetirements = 0;
  private totalGenerationBusyTaints = 0;
  private bulkPreheatTail: Promise<void> | null = null;
  private retirementBudgetExceeded = false;
  private workerRecycleRequired = false;
  private workerRecycleNotificationSent = false;
  private workerRecycleNotificationDeferred = false;
  private admissionBlocked = false;
  private totalAdmissionRejected = 0;
  private activeWorkers = new Set<Worker>();
  private retiredWorkers = new Map<Worker, RetiredWorker>();
  private workerMetadata = new Map<
    Worker,
    {
      generation: number;
      projectRef?: string;
      replacementTimer?: ReturnType<typeof setTimeout>;
      parkedTimer?: ReturnType<typeof setTimeout>;
      surplusTimer?: ReturnType<typeof setTimeout>;
      isCancelling?: boolean;
      active?: WorkerExecutionHandlers;
    }
  >();
  private parkedWorkers = new Set<Worker>();
  private totalProjectAffinityHits = 0;
  private totalParkedWorkerReuses = 0;
  private totalProjectWorkerEvictions = 0;
  private totalWorkerCreateMs = 0;
  private totalWorkerSurplusCreations = 0;
  private totalWorkerSurplusRetirements = 0;
  private tainted = new Set<Worker>();
  private draining = false;
  private admissionRecovering = false;

  private readonly retirementBudget: {
    maxRetiredWorkers: number;
    maxRetirementAgeMs: number;
  };
  private readonly onRetirementBudgetExceeded: (exceeded: RetirementBudgetExceeded) => void;
  private readonly maxWorkerReplacementsBeforeRecycle: number;
  private readonly onWorkerRecycleRequired: (event: WorkerPoolRecycleRequired) => void;
  private readonly maxWorkers: number;
  private readonly parkedWorkerIdleMs: number;
  private readonly maxConcurrentExecutions: number;

  constructor(private config: WorkerPoolConfig) {
    this.responseReadAheadBytes = config.responseReadAheadBytes
      ?? (process.env.EDGE_RESPONSE_READ_AHEAD_BYTES === "0" ? 0
        : positiveBytes(process.env.EDGE_RESPONSE_READ_AHEAD_BYTES, 16 * 1024 * 1024));
    if (!Number.isSafeInteger(this.responseReadAheadBytes) || this.responseReadAheadBytes < 0) {
      throw new Error("EDGE_RESPONSE_READ_AHEAD_BYTES must be a non-negative integer");
    }
    if ((config.responseBufferBudget ?? responseBufferBudget).limit < BODY_CHUNK_BYTES) {
      throw new Error("Response buffer budget must allow at least one 512 KiB chunk");
    }
    this.retirementBudget = config.retirementBudget ?? {
      maxRetiredWorkers: Math.max((config.maxConcurrentExecutions ?? config.size) * 2, 8),
      maxRetirementAgeMs: DEFAULT_MAX_RETIREMENT_AGE_MS,
    };
    this.onRetirementBudgetExceeded = config.onRetirementBudgetExceeded ?? ((exceeded) => {
      console.error("[Pool] Worker retirement budget exceeded; restarting Edge Runtime", exceeded);
      process.exit(1);
    });
    this.maxWorkerReplacementsBeforeRecycle = config.maxWorkerReplacementsBeforeRecycle
      ?? DEFAULT_MAX_WORKER_REPLACEMENTS_BEFORE_RECYCLE;
    this.onWorkerRecycleRequired = config.onWorkerRecycleRequired ?? (() => process.exit(1));
    this.maxWorkers = (config.maxConcurrentExecutions ?? config.size) + (config.maxExtraProjectWorkers
      ?? DEFAULT_MAX_EXTRA_PROJECT_WORKERS);
    this.parkedWorkerIdleMs = config.parkedWorkerIdleMs ?? DEFAULT_PARKED_WORKER_IDLE_MS;
    if (!Number.isSafeInteger(this.maxWorkers) || this.maxWorkers < (config.maxConcurrentExecutions ?? config.size)) {
      throw new TypeError("maxExtraProjectWorkers must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(this.parkedWorkerIdleMs) || this.parkedWorkerIdleMs < 0) {
      throw new TypeError("parkedWorkerIdleMs must be a non-negative safe integer");
    }
    this.maxConcurrentExecutions = config.maxConcurrentExecutions ?? config.size;
    if (!Number.isSafeInteger(this.maxConcurrentExecutions)
      || this.maxConcurrentExecutions < config.size) {
      throw new TypeError("maxConcurrentExecutions must be a safe integer of at least size");
    }
    for (let i: number = 0; i < config.size; i++) {
      const w = this.createWorker();
      this.idle.push(w);
      this.activeWorkers.add(w);
    }
  }

  private createWorker(): Worker {
    const start = performance.now();
    const workerEntry = resolveWorkerEntry();
    const options: WorkerOptions & { smol?: boolean } = {
      ...(this.config.smol ? { smol: true } : {}),
    };
    const w = new Worker(workerEntry, options);
    this.totalWorkerCreateMs += performance.now() - start;
    this.workers.push(w);
    this.workerMetadata.set(w, { generation: this.workerGeneration });
    // Request routing is a per-worker dispatch, not a per-request listener: a
    // warm slot multiplexes executions over its lifetime, so installing and
    // tearing down three listeners on every dispatch shows up as measurable
    // EventEmitter overhead on the hot path.
    w.on("message", (message: WorkerResponseMessage) => {
      this.workerMetadata.get(w)?.active?.onMessage(message);
    });
    w.on("error", (error: Error) => {
      const active = this.workerMetadata.get(w)?.active;
      if (active) {
        active.onError(error);
        return;
      }
      // No execution owns this worker; an unowned error would otherwise be an
      // unhandled emitter error, so drop the slot instead of leaking it.
      console.warn("[Pool] Idle worker error; replacing", error);
      if (!this.draining && (this.activeWorkers.has(w) || this.parkedWorkers.has(w))) {
        this.retireWorker(w);
      }
    });
    w.once("exit", () => {
      this.workerMetadata.get(w)?.active?.onExit();
      this.onWorkerExit(w);
    });
    return w;
  }

  private resolveTlsPolicy(env: Record<string, string>): Promise<EdgeFetchTlsPolicy> {
    // Bun smol workers do not reliably inherit the parent process env. Resolve
    // host-controlled TLS policy in the main process and pass it as message data.
    return resolveEdgeFetchTlsPolicy(
      env,
      process.env,
      (caFile) => Bun.file(caFile).text(),
    );
  }

  async dispatch(opts: DispatchOptions): Promise<Response> {
    if (this.draining) {
      return new Response(JSON.stringify({ error: "Server is shutting down" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (this.rejectAdmission()) {
      this.totalAdmissionRejected++;
      return admissionBlockedResponse();
    }

    assertCanonicalPositiveFunctionVersion(opts.functionVersion);

    this.totalRequests++;
    if (opts.envLoadMs) this.totalEnvLoadMs += opts.envLoadMs;
    const executionKey = crypto.randomUUID();
    const signal = opts.signal ?? opts.request.signal;
    if (signal.aborted) return cancelledResponse();

    const budget = this.config.bodyBufferBudget ?? bodyBufferBudget;
    const queueLease = budget.lease();
    const maxBody = Math.min(MAX_BODY_SIZE, opts.limits?.max_request_body_bytes ?? MAX_BODY_SIZE);
    const declared = Number(opts.request.headers.get("content-length"));
    try {
      queueLease.resize(BODY_CHUNK_BYTES + (opts.request.body
        ? Number.isSafeInteger(declared) && declared > 0 ? Math.min(declared, maxBody) : maxBody
        : 0));
    } catch {
      if (opts.request.body && !opts.request.body.locked) void opts.request.body.cancel().catch(() => {});
      return admissionBlockedResponse();
    }
    let queued = true;
    const responsePromise = this.enqueue({ ...opts, executionKey, releaseQueueReservation: () => {
      queued = false;
      queueLease.release();
    } });
    const cancelDispatch = () => {
      this.cancelExecution(executionKey);
    };
    signal.addEventListener("abort", cancelDispatch, { once: true });
    if (signal.aborted) cancelDispatch();

    try {
      return await responsePromise;
    } finally {
      signal.removeEventListener("abort", cancelDispatch);
      queueLease.release();
      if (queued && opts.request.body && !opts.request.body.locked) void opts.request.body.cancel().catch(() => {});
    }
  }

  private enqueue(opts: ScheduledDispatch): Promise<Response> {
    const enqueuedAt = performance.now();
    return new Promise<Response>((resolve, reject) => {
      if (this.rejectAdmission()) {
        this.totalAdmissionRejected++;
        resolve(admissionBlockedResponse());
        return;
      }
      if (this.queuedCount >= MAX_QUEUE_SIZE) {
        resolve(new Response(JSON.stringify({ error: "Too many concurrent requests, please retry" }), {
          status: 503,
          headers: { "Content-Type": "application/json", "Retry-After": "5" },
        }));
        return;
      }

      const worker = this.takeIdleWorker(this.projectKey(opts));
      if (worker) {
        this.lastDispatchedProjectRef = this.projectKey(opts);
        this.execute(worker, opts, null, resolve).catch(reject);
      } else {
        this.totalQueuedRequests++;
        this.enqueueQueued({ opts, enqueuedAt, resolve, reject });
        this.ensureCapacityForQueuedWork();
      }
    });
  }

  private projectKey(opts: DispatchOptions): string {
    return opts.projectRef;
  }

  private rejectAdmission(): boolean {
    return this.admissionBlocked || (this.admissionRecovering
      && (this.activeWorkers.size > this.idle.length || this.queuedCount > 0));
  }

  private workerProjectRef(worker: Worker): string | undefined {
    return this.workerMetadata.get(worker)?.projectRef;
  }

  // Functions within one project share a trust boundary; a Worker never crosses it.
  private workerAcceptsProject(worker: Worker, projectRef: string): boolean {
    const assignedProjectRef = this.workerProjectRef(worker);
    return assignedProjectRef === undefined || assignedProjectRef === projectRef;
  }

  private assignWorkerProject(worker: Worker, projectRef: string): void {
    const metadata = this.workerMetadata.get(worker);
    if (!metadata) throw new Error("Missing worker metadata");
    if (metadata.projectRef !== undefined && metadata.projectRef !== projectRef) {
      throw new Error("Worker cannot execute a different project");
    }
    metadata.projectRef = projectRef;
  }

  private takeIdleWorker(projectRef: string): Worker | undefined {
    const workerIndex = this.idle.findLastIndex((worker) => (
      this.workerProjectRef(worker) === projectRef && !this.tainted.has(worker)
    ));
    const fallbackIndex = workerIndex >= 0
      ? workerIndex
      : this.idle.findLastIndex((worker) => (
        this.workerAcceptsProject(worker, projectRef) && !this.tainted.has(worker)
      ));
    if (fallbackIndex < 0) return undefined;
    const worker = this.idle.splice(fallbackIndex, 1)[0];
    this.clearSurplusTimer(worker);
    if (workerIndex >= 0) this.totalProjectAffinityHits++;
    return worker;
  }

  private ensureWorkerForQueuedProject(): void {
    for (const worker of [...this.idle]) {
      if (this.queuedCount === 0) return;
      this.idle = this.idle.filter((candidate) => candidate !== worker);
      this.schedule(worker);
    }
  }

  /**
   * Explicit burst capacity is used only while admission is fully open.
   */
  private ensureCapacityForQueuedWork(): void {
    this.ensureWorkerForQueuedProject();
    if (this.queuedCount === 0) return;
    if (this.draining || this.admissionBlocked || this.admissionRecovering) return;
    if (this.activeWorkers.size >= this.maxConcurrentExecutions) return;
    if (this.workerRecycleRequired) return;
    if (this.activeWorkers.size + this.parkedWorkers.size + this.retiredWorkers.size >= this.maxWorkers) return;
    const worker = this.createWorker();
    this.totalWorkerSurplusCreations++;
    this.activeWorkers.add(worker);
    this.schedule(worker);
  }

  // A parked worker retains its project, but owns no execution slot.
  private parkWorker(worker: Worker): void {
    this.clearSurplusTimer(worker);
    this.activeWorkers.delete(worker);
    this.idle = this.idle.filter(candidate => candidate !== worker);
    this.parkedWorkers.add(worker);
    const metadata = this.workerMetadata.get(worker);
    if (!metadata) return;
    if (metadata.parkedTimer) clearTimeout(metadata.parkedTimer);
    if (this.parkedWorkerIdleMs <= 0 || this.admissionRecovering) {
      this.evictParkedWorker(worker);
      return;
    }
    metadata.parkedTimer = setTimeout(() => {
      metadata.parkedTimer = undefined;
      this.evictParkedWorker(worker);
    }, this.parkedWorkerIdleMs);
    metadata.parkedTimer.unref?.();
  }

  private unparkWorker(worker: Worker): void {
    this.parkedWorkers.delete(worker);
    const metadata = this.workerMetadata.get(worker);
    if (!metadata?.parkedTimer) return;
    clearTimeout(metadata.parkedTimer);
    metadata.parkedTimer = undefined;
  }

  private evictParkedWorker(worker: Worker): void {
    if (!this.parkedWorkers.has(worker)) return;
    this.totalProjectWorkerEvictions++;
    this.retireWorker(worker);
  }

  private switchProjectSlot(worker: Worker, projectRef: string): Worker {
    const cached = [...this.parkedWorkers].find(
      candidate => this.workerProjectRef(candidate) === projectRef
        && this.workerMetadata.get(candidate)?.generation === this.workerGeneration
        && !this.tainted.has(candidate),
    );
    if (cached) this.unparkWorker(cached);
    this.parkWorker(worker);
    while (this.parkedWorkers.size > this.maxWorkers - this.maxConcurrentExecutions) {
      const oldest = this.parkedWorkers.values().next().value;
      if (oldest) this.evictParkedWorker(oldest);
    }
    if (!cached) this.recordWorkerReplacement();
    else this.totalParkedWorkerReuses++;
    const replacement = cached ?? this.createWorker();
    this.assignWorkerProject(replacement, projectRef);
    this.activeWorkers.add(replacement);
    return replacement;
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

  private dequeueQueuedForWorker(worker: Worker): QueuedDispatch | null {
    const projectRef = this.workerProjectRef(worker);
    if (projectRef === undefined) return this.dequeueQueued();
    const projectQueue = this.queuedDispatches.get(projectRef);
    if (!projectQueue) return null;
    const entry = projectQueue.shift();
    if (!entry) throw new Error(`Empty dispatch queue for project ${projectRef}`);

    this.queuedCount--;
    this.queuedProjects = this.queuedProjects.filter((queuedProject) => queuedProject !== projectRef);
    if (projectQueue.length === 0) {
      this.queuedDispatches.delete(projectRef);
    } else {
      this.queuedProjects.push(projectRef);
    }
    this.lastDispatchedProjectRef = projectRef;
    return entry;
  }

  private invalidateQueuedProject(projectRef: string): number {
    const projectQueue = this.queuedDispatches.get(projectRef);
    if (!projectQueue) return 0;
    this.queuedDispatches.delete(projectRef);
    this.queuedProjects = this.queuedProjects.filter(
      (queuedProject) => queuedProject !== projectRef,
    );
    this.queuedCount -= projectQueue.length;
    for (const entry of projectQueue) {
      entry.resolve(invalidatedBeforeExecutionResponse());
    }
    return projectQueue.length;
  }

  private async execute(
    worker: Worker,
    opts: ScheduledDispatch,
    enqueuedAt: number | null,
    resolve: (response: Response) => void,
  ) {
    opts.releaseQueueReservation();
    this.assignWorkerProject(worker, this.projectKey(opts));
    this.totalQueueWaitMs += enqueuedAt === null ? 0 : Math.round(performance.now() - enqueuedAt);
    const budget = this.config.bodyBufferBudget ?? bodyBufferBudget;
    const inputLease = budget.lease();
    const outputLease = budget.lease();
    const abort = new AbortController();
    const signal = opts.signal ?? opts.request.signal;
    let resolved = false;
    let finished = false;
    let started = false;
    let streamDone = true;
    let executionDone = false;
    let responseReceived = false;
    let pendingResponse: Response | undefined;
    let readingRequest = false;
    let failStream: ((error: Error) => void) | undefined;
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    let body: ArrayBuffer | null = null;
    let cancellationRequested = false;
    const execStart = performance.now();
    const resolveOnce = (response: Response, fromWorker = false) => {
      if (resolved) return;
      resolved = true;
      // Worker responses already carry the runtime-owned version header, so the
      // hot path returns them untouched. Locally built responses (cancellations,
      // timeouts, crashes) still need the header stamped when the execution
      // actually started.
      resolve(started && !fromWorker
        ? withRuntimeFunctionVersion(response, opts.functionVersion)
        : response);
    };
    const cleanup = () => {
      finished = true;
      clearTimeout(timeout);
      clearTimeout(waitTimer);
      clearTimeout(cancelTimer);
      if (this.workerMetadata.get(worker)?.active === handlers) {
        this.workerMetadata.get(worker)!.active = undefined;
      }
      signal.removeEventListener("abort", cancel);
      this.inFlight.delete(opts.executionKey);
      inputLease.release();
      body = null;
    };
    const releaseResponse = (error: Error) => {
      const failBody = failStream;
      failStream = undefined;
      if (failBody) failBody(error);
      else outputLease.release();
    };
    const retireWithFailure = (status: number, error: Error) => {
      if (finished) return;
      releaseResponse(error);
      cleanup();
      abort.abort(error);
      resolveOnce(status === 499 ? cancelledResponse() : new Response(error.message, { status }));
      this.retireWorker(worker);
    };
    const requestCancellation = (status: number, error: Error) => {
      if (finished || cancellationRequested) return;
      cancellationRequested = true;
      clearTimeout(timeout);
      abort.abort(error);
      if (!started) {
        releaseResponse(error);
        cleanup();
        resolveOnce(status === 499 ? cancelledResponse() : new Response(error.message, { status }));
        this.recycle(worker);
        return;
      }
      if (failStream) streamDone = true;
      releaseResponse(error);
      pendingResponse = undefined;
      resolveOnce(status === 499 ? cancelledResponse() : new Response(error.message, { status }));
      if (executionDone) { streamDone = true; complete(); return; }
      try {
        worker.postMessage({ type: "cancel_current", executionKey: opts.executionKey });
      } catch {
        retireWithFailure(status, error);
        return;
      }
      cancelTimer = setTimeout(() => retireWithFailure(status, error), 3_000);
      cancelTimer.unref?.();
    };
    const complete = () => {
      if (finished || !executionDone || !streamDone) return;
      cleanup();
      this.recycle(worker);
    };
    const timeout = setTimeout(() => requestCancellation(504, new Error("Gateway Timeout")),
      Math.min(this.config.requestTimeout, opts.limits?.timeout_ms ?? this.config.requestTimeout));
    const cancel = () => {
      requestCancellation(499, new Error("Task cancelled"));
    };
    const onError = (error: Error) => retireWithFailure(500, error);
    const onExit = () => retireWithFailure(500, new Error("Function worker exited"));
    const onMessage = (msg: WorkerResponseMessage) => {
      if (finished) return;
      if (msg.type === "execution_started") { opts.onExecutionStarted?.(); return; }
      if (msg.type === "log") {
        if (msg.timestamp && msg.stream && msg.level && msg.message) opts.onLog?.({
          timestamp: msg.timestamp, stream: msg.stream, level: msg.level, message: msg.message,
        });
        return;
      }
      if (msg.type === "response_complete") {
        if (msg.waitUntilPending && pendingResponse) { resolveOnce(pendingResponse, true); pendingResponse = undefined; }
        clearTimeout(timeout);
        waitTimer = setTimeout(() => retireWithFailure(504, new Error("EdgeRuntime.waitUntil timed out")),
          Math.min(WAIT_UNTIL_TIMEOUT_MS, opts.limits?.wait_until_timeout_ms ?? WAIT_UNTIL_TIMEOUT_MS));
        return;
      }
      if (msg.type === "execution_complete") {
        executionDone = true;
        if (cancellationRequested) streamDone = true;
        clearTimeout(waitTimer);
        this.recordWorkerMemory(worker, msg);
        complete();
        if (pendingResponse) { resolveOnce(pendingResponse, true); pendingResponse = undefined; }
        return;
      }
      if (cancellationRequested) { msg.port?.close(); return; }
      if (msg.status === undefined || responseReceived) return;
      responseReceived = true;
      this.totalWorkerExecMs += Math.round(performance.now() - execStart);
      this.recordModuleCacheStats(msg);
      const headers = new Headers();
      for (const [name, value] of Object.entries(msg.headers ?? {})) {
        if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
        else headers.set(name, value);
      }
      // Stamp the runtime-owned version header here so the response can be
      // handed back as-is instead of being cloned into a second Response.
      if (started) {
        if (opts.functionVersion === null || opts.functionVersion === undefined) {
          headers.delete(FUNCTION_VERSION_HEADER);
        } else {
          headers.set(FUNCTION_VERSION_HEADER, opts.functionVersion);
        }
      }
      if (msg.port) {
        streamDone = false;
        let deliveryDone = false;
        const received = receiveBufferedResponse({
          port: msg.port, lease: outputLease, bodyBudget: budget,
          responseBudget: this.config.responseBufferBudget ?? responseBufferBudget,
          readAheadBytes: this.responseReadAheadBytes, signal,
          idleTimeoutMs: Math.min(this.config.requestTimeout, opts.limits?.timeout_ms ?? this.config.requestTimeout),
          onCancel: (error) => requestCancellation(error ? 500 : 499, error ?? new Error("Function body cancelled")),
          onProducerDone: () => { streamDone = true; complete(); },
          onConsumerDone: () => { deliveryDone = true; this.responseDeliveries.delete(opts.executionKey); },
        });
        if (!deliveryDone) this.responseDeliveries.set(opts.executionKey, received.fail);
        failStream = received.fail;
        resolveOnce(new Response(received.stream, { status: msg.status, headers }), true);
      } else {
        try { outputLease.resize(msg.body?.byteLength ?? 0); }
        catch (error) { requestCancellation(503, error as Error); return; }
        let responseBody: ReadableStream<Uint8Array> | null = null;
        if (msg.body) {
          let deliveryDone = false;
          const received = bufferedBody(msg.body, {
            release: outputLease.release, signal,
            idleTimeoutMs: Math.min(this.config.requestTimeout, opts.limits?.timeout_ms ?? this.config.requestTimeout),
            onDone: () => { deliveryDone = true; this.responseDeliveries.delete(opts.executionKey); },
          });
          if (!deliveryDone) this.responseDeliveries.set(opts.executionKey, received.fail);
          failStream = received.fail;
          responseBody = received.stream;
        }
        pendingResponse = new Response(responseBody, { status: msg.status, headers });
      }
    };
    this.inFlight.set(opts.executionKey, { cancel, cancelKey: opts.cancelKey });
    const metadata = this.workerMetadata.get(worker);
    if (!metadata) throw new Error("Missing worker metadata");
    const handlers: WorkerExecutionHandlers = { onMessage, onError, onExit };
    metadata.active = handlers;
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    try {
      outputLease.resize(BODY_CHUNK_BYTES);
      if (opts.request.body && !["GET", "HEAD"].includes(opts.request.method)) {
        const max = Math.min(MAX_BODY_SIZE, opts.limits?.max_request_body_bytes ?? MAX_BODY_SIZE);
        const declared = Number(opts.request.headers.get("content-length"));
        if (declared > max) throw new BodyLimitError(max);
        readingRequest = true;
        body = await readBoundedBody(opts.request.body, max, abort.signal, inputLease.resize);
        readingRequest = false;
        inputLease.resize(body.byteLength);
      }
      if (finished) return;
      const tlsPolicy = await this.resolveTlsPolicy(opts.env);
      if (finished) return;
      const headers: Record<string, string | string[]> = {};
      opts.request.headers.forEach((value, name) => {
        if (name !== "set-cookie" && name !== FUNCTION_VERSION_HEADER) headers[name] = value;
      });
      const cookies = opts.request.headers.getSetCookie();
      if (cookies.length) headers["set-cookie"] = cookies;
      worker.postMessage({
        executionKey: opts.executionKey,
        functionId: opts.functionId, functionPath: opts.functionPath,
        projectRoot: opts.projectRoot, projectRef: opts.projectRef,
        framework: opts.framework, capabilities: opts.capabilities, limits: opts.limits,
        moduleVersion: opts.moduleVersion, envProof: opts.envProof,
        artifactSha256: opts.artifactSha256, bytecode: opts.bytecode,
        bytecodeArtifact: functionBytecodeCache.lookup(opts), env: opts.env,
        internalBindings: opts.internalBindings, tlsPolicy,
        url: opts.request.url, method: opts.request.method, headers, body,
      }, body ? [body] : []);
      body = null;
      started = true;
    } catch (error) {
      if (finished) return;
      if (started) {
        retireWithFailure(500, error instanceof Error ? error : new Error(String(error)));
        return;
      }
      cleanup(); outputLease.release();
      if (opts.request.body && !opts.request.body.locked) void opts.request.body.cancel().catch(() => {});
      resolveOnce(error instanceof BodyLimitError
        ? new Response(JSON.stringify({ error: `Request body too large (max ${formatBodyLimit(error.limit)})` }),
            { status: 413, headers: { "Content-Type": "application/json" } })
        : error instanceof BufferBudgetError ? admissionBlockedResponse()
        : new Response(readingRequest ? "Failed to read request" : "Internal Error", { status: readingRequest ? 400 : 500 }));
      this.recycle(worker);
    }
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

  /**
   * Shrinks a grown pool back to its warm size once nothing is queued, so burst
   * concurrency does not keep extra threads and heaps resident forever. Surplus
   * workers retire after a short idle grace, preserving warm state across bursts.
   */
  private shouldRetireSurplusWorker(): boolean {
    return !this.draining
      && this.maxConcurrentExecutions > this.config.size
      && this.activeWorkers.size > this.config.size
      && this.queuedCount === 0;
  }

  private clearSurplusTimer(worker: Worker): void {
    const metadata = this.workerMetadata.get(worker);
    if (!metadata?.surplusTimer) return;
    clearTimeout(metadata.surplusTimer);
    metadata.surplusTimer = undefined;
  }

  private retireSurplusWorker(worker: Worker): void {
    this.totalWorkerSurplusRetirements++;
    this.retireWorker(worker, false);
    this.checkWorkerRecycleBudget();
  }

  private deferSurplusRetirement(worker: Worker): void {
    const metadata = this.workerMetadata.get(worker)!;
    if (metadata.surplusTimer) return;
    metadata.surplusTimer = setTimeout(() => {
      metadata.surplusTimer = undefined;
      if (this.shouldRetireSurplusWorker() && this.idle.includes(worker)) {
        this.retireSurplusWorker(worker);
      }
    }, SURPLUS_WORKER_IDLE_MS);
    metadata.surplusTimer.unref?.();
  }

  private schedule(worker: Worker) {
    this.clearSurplusTimer(worker);
    if (this.tainted.has(worker)) {
      this.retireWorker(worker);
      return;
    }
    if (this.shouldRetireSurplusWorker()) {
      if (this.admissionBlocked || this.admissionRecovering) this.retireSurplusWorker(worker);
      else {
        this.idle.push(worker);
        this.deferSurplusRetirement(worker);
      }
      return;
    }
    if (this.draining || this.admissionBlocked) {
      this.idle.push(worker);
      return;
    }
    const assignedProjectRef = this.workerProjectRef(worker);
    // Preserve warm slots when every queued project already has capacity.
    // An unrepresented project gets the next completed slot, even under load.
    const uncoveredProject = this.queuedProjects.find(projectRef => (
      projectRef !== assignedProjectRef && ![...this.activeWorkers].some(
        candidate => this.workerProjectRef(candidate) === projectRef && !this.tainted.has(candidate),
      )
    ));
    const targetProject = uncoveredProject
      ?? (assignedProjectRef && this.queuedDispatches.has(assignedProjectRef)
        ? assignedProjectRef : this.queuedProjects[0]);
    if (targetProject === undefined) {
      this.idle.push(worker);
      return;
    }
    if (!this.workerAcceptsProject(worker, targetProject)) {
      worker = this.switchProjectSlot(worker, targetProject);
    } else {
      if (assignedProjectRef === targetProject) this.totalProjectAffinityHits++;
      this.assignWorkerProject(worker, targetProject);
    }
    const next = this.dequeueQueuedForWorker(worker);
    if (!next) {
      this.idle.push(worker);
      return;
    }
    this.execute(worker, next.opts, next.enqueuedAt, next.resolve).catch(next.reject);
  }

  private retireWorker(worker: Worker, replace = true) {
    this.workerMemory.delete(worker);
    const ownedSlot = this.activeWorkers.delete(worker);
    const wasParked = this.parkedWorkers.delete(worker);
    if (!ownedSlot && !wasParked) return;
    this.totalWorkerRetirements++;
    this.clearSurplusTimer(worker);
    const metadata = this.workerMetadata.get(worker);
    if (metadata?.replacementTimer) clearTimeout(metadata.replacementTimer);
    if (metadata?.parkedTimer) clearTimeout(metadata.parkedTimer);
    this.workerMetadata.delete(worker);
    this.tainted.delete(worker);
    this.parkedWorkers.delete(worker);
    const idleIdx = this.idle.indexOf(worker);
    if (idleIdx !== -1) this.idle.splice(idleIdx, 1);
    this.trackRetiredWorker(worker);

    try {
      worker.postMessage({ type: "retire" });
    } catch (error) {
      console.warn("[Pool] Failed to signal cooperative worker retirement", error);
    }
    // A cancelled tenant producer may throw from a pending timer after retirement.
    worker.on("error", () => {});
    worker.unref();

    if (!this.draining && ownedSlot && replace) {
      this.recordWorkerReplacement();
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
    if (retired && !this.draining) this.ensureCapacityForQueuedWork();
    if (!this.activeWorkers.delete(worker) || this.draining) return;

    this.recordWorkerReplacement();
    const replacement = this.createWorker();
    this.activeWorkers.add(replacement);
    this.schedule(replacement);
  }

  private recordWorkerReplacement(): void {
    this.totalWorkerReplacements++;
    this.checkWorkerRecycleBudget();
  }

  private checkWorkerRecycleBudget(): void {
    if (this.totalWorkerReplacements + this.totalWorkerSurplusRetirements >= this.maxWorkerReplacementsBeforeRecycle) {
      this.workerRecycleRequired = true;
    }
    this.notifyWorkerRecycleRequired();
  }

  private notifyWorkerRecycleRequired(): void {
    if (
      !this.workerRecycleRequired ||
      this.workerRecycleNotificationSent ||
      this.workerRecycleNotificationDeferred
    ) return;

    this.workerRecycleNotificationSent = true;
    const event = {
      workerReplacements: this.totalWorkerReplacements,
      surplusRetirements: this.totalWorkerSurplusRetirements,
      maxWorkerReplacements: this.maxWorkerReplacementsBeforeRecycle,
    };
    console.warn("[Pool] Worker replacement budget reached; recycling Edge Runtime", event);
    this.onWorkerRecycleRequired(event);
  }

  private removeWorkerReferences(worker: Worker) {
    this.clearSurplusTimer(worker);
    this.workerMemory.delete(worker);
    const metadata = this.workerMetadata.get(worker);
    if (metadata?.parkedTimer) clearTimeout(metadata.parkedTimer);
    this.workerMetadata.delete(worker);
    this.tainted.delete(worker);
    this.parkedWorkers.delete(worker);
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

  setAdmissionBlocked(blocked: boolean, recovering = false): void {
    if (this.admissionBlocked === blocked && this.admissionRecovering === recovering) return;
    this.admissionBlocked = blocked;
    this.admissionRecovering = recovering && !blocked;
    if (!blocked) return;

    for (const projectQueue of this.queuedDispatches.values()) {
      for (const entry of projectQueue) {
        this.totalAdmissionRejected++;
        entry.resolve(admissionBlockedResponse());
      }
    }
    this.queuedDispatches.clear();
    this.queuedProjects = [];
    this.queuedCount = 0;
    for (const worker of [...this.parkedWorkers]) {
      this.evictParkedWorker(worker);
    }
    for (const worker of [...this.idle]) {
      if (this.activeWorkers.size <= this.config.size) break;
      this.retireSurplusWorker(worker);
    }
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
    const workers = [...this.activeWorkers, ...this.parkedWorkers];
    const results = await Promise.all(
      workers.map(async (worker) => ({
        worker,
        result: await this.sendControlMessage(worker, message),
      })),
    );
    for (const { worker, result } of results) {
      if (result.acked) continue;
      if (this.idle.includes(worker) || this.parkedWorkers.has(worker)) {
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
      generation: this.workerGeneration,
      attempted: workers.length,
      succeeded: results.filter((item) => item.result.acked).length,
      invalidated,
      cancelledQueued: 0,
    };
  }

  private invalidateProjectWorkers(projectRef: string): Promise<WorkerControlAck[]> {
    const workers = [...this.activeWorkers, ...this.parkedWorkers].filter(
      (worker) => this.workerProjectRef(worker) === projectRef,
    );
    for (const worker of workers) this.tainted.add(worker);
    return Promise.all(workers.map(async (worker) => {
      const acknowledgement = await this.sendControlMessage(worker, {
        type: "invalidate_project",
        projectRef,
      });
      if (this.idle.includes(worker) || this.parkedWorkers.has(worker)) {
        this.retireWorker(worker);
      }
      return acknowledgement;
    }));
  }

  invalidateModule(functionId: string): Promise<WorkerPoolControlResult> {
    console.log(`[Pool] Invalidating module: ${functionId}`);
    return this.invalidateWorkers({ type: "invalidate_module", functionId });
  }

  async invalidateProject(projectRef: string): Promise<WorkerPoolControlResult> {
    console.log(`[Pool] Invalidating project modules: ${projectRef}`);
    const cancelledQueued = this.invalidateQueuedProject(projectRef);
    this.totalInvalidations++;
    const acknowledgements = await this.invalidateProjectWorkers(projectRef);
    const invalidated = acknowledgements.reduce(
      (sum, acknowledgement) => sum + acknowledgement.invalidated,
      0,
    );
    const latestModuleCacheSize = acknowledgements.at(-1)?.moduleCacheSize;
    if (latestModuleCacheSize !== undefined) this.lastModuleCacheEntries = latestModuleCacheSize;
    this.totalModuleCacheInvalidated += invalidated;
    return {
      generation: this.workerGeneration,
      attempted: acknowledgements.length,
      succeeded: acknowledgements.filter((acknowledgement) => acknowledgement.acked).length,
      invalidated,
      cancelledQueued,
    };
  }

  private rotateWorkerForGeneration(worker: Worker): GenerationRotationDisposition {
    if (this.parkedWorkers.has(worker)) {
      this.retireWorker(worker);
      return "parked-retired";
    }
    if (this.idle.includes(worker)) {
      this.retireWorker(worker);
      return "idle-retired";
    }
    if (this.tainted.has(worker)) return "already-tainted";
    this.tainted.add(worker);
    return "busy-tainted";
  }

  private rotateGeneration(): WorkerPoolGenerationRotationResult {
    this.workerGeneration++;
    this.totalGenerationRotations++;
    const replacementsBefore = this.totalWorkerReplacements;
    const workers = [...this.activeWorkers, ...this.parkedWorkers].filter(
      (worker) => (this.workerMetadata.get(worker)?.generation ?? -1) < this.workerGeneration,
    );
    const dispositions = workers.map((worker) => this.rotateWorkerForGeneration(worker));
    const idleRetired = dispositions.filter((value) => value === "idle-retired").length;
    const parkedRetired = dispositions.filter((value) => value === "parked-retired").length;
    const busyTainted = dispositions.filter((value) => value === "busy-tainted").length;
    const alreadyTainted = dispositions.filter((value) => value === "already-tainted").length;
    this.totalGenerationIdleRetirements += idleRetired + parkedRetired;
    this.totalGenerationBusyTaints += busyTainted;
    return {
      generation: this.workerGeneration,
      attempted: workers.length,
      idleRetired,
      parkedRetired,
      busyTainted,
      alreadyTainted,
      immediateReplacements: this.totalWorkerReplacements - replacementsBefore,
    };
  }

  private failedPreheat(request: WorkerPreheatRequest, error: string): WorkerPreheatResult {
    this.retireWorker(request.worker);
    return {
      success: false,
      cacheHit: null,
      moduleCacheSize: this.lastModuleCacheEntries,
      attestation: null,
      error,
    };
  }

  private completedPreheat(
    request: WorkerPreheatRequest,
    message: WorkerPreheatMessage,
  ): WorkerPreheatResult {
    const attestation = acceptedPreheatAttestation(
      message.attestation,
      request.options.attestation,
    );
    if (attestation === false) {
      return this.failedPreheat(request, "Worker preheat attestation mismatch");
    }
    this.recordModuleCacheStats(message);
    this.recordWorkerMemory(request.worker, message);
    if (this.tainted.has(request.worker)) {
      return this.failedPreheat(request, "Function preheat exceeded the worker memory budget");
    }
    return {
      success: true,
      cacheHit: typeof message.moduleCacheHit === "boolean" ? message.moduleCacheHit : null,
      moduleCacheSize: typeof message.moduleCacheSize === "number"
        ? message.moduleCacheSize
        : this.lastModuleCacheEntries,
      attestation,
    };
  }

  private preheatMessageResult(
    request: WorkerPreheatRequest,
    message: WorkerPreheatMessage,
  ): WorkerPreheatResult | null {
    if (message.functionId !== request.functionId) return null;
    if (message.type === "preheat_done") return this.completedPreheat(request, message);
    if (message.type !== "preheat_error") return null;
    return this.failedPreheat(
      request,
      typeof message.error === "string" ? message.error : "Worker preheat failed",
    );
  }

  private postPreheatMessage(
    request: WorkerPreheatRequest,
    tlsPolicy: EdgeFetchTlsPolicy,
  ): void {
    request.worker.postMessage({
      type: "preheat",
      functionId: request.functionId,
      functionPath: request.functionPath,
      projectRoot: request.projectRoot,
      projectRef: request.options.projectRef,
      moduleVersion: request.options.moduleVersion,
      envProof: request.options.envProof,
      artifactSha256: request.options.attestation?.artifact_sha256,
      bytecode: request.options.bytecode,
      bytecodeArtifact: request.options.bytecodeArtifact,
      attestation: request.options.attestation,
      env: request.env,
      tlsPolicy,
    });
  }

  private waitForWorkerPreheat(
    request: WorkerPreheatRequest,
    tlsPolicy: EdgeFetchTlsPolicy,
  ): Promise<WorkerPreheatResult> {
    return new Promise((resolve) => {
      const finish = (preheat: WorkerPreheatResult) => {
        clearTimeout(timeout);
        request.worker.removeListener("message", onMessage);
        resolve(preheat);
      };
      const onMessage = (message: WorkerPreheatMessage) => {
        const preheat = this.preheatMessageResult(request, message);
        if (preheat) finish(preheat);
      };
      const timeout = setTimeout(() => {
        finish(this.failedPreheat(request, "Worker preheat timed out"));
      }, this.config.preheatTimeoutMs ?? DEFAULT_PREHEAT_TIMEOUT_MS);
      request.worker.on("message", onMessage);
      try {
        this.postPreheatMessage(request, tlsPolicy);
      } catch (error) {
        console.warn("[Pool] Failed to dispatch worker preheat", error);
        finish(this.failedPreheat(
          request,
          error instanceof Error ? error.message : String(error),
        ));
      }
    });
  }

  private async preheatWorker(request: WorkerPreheatRequest): Promise<WorkerPreheatResult> {
    this.assignWorkerProject(request.worker, request.options.projectRef);
    try {
      const bytecodeArtifact = await functionBytecodeCache.prepare({
        functionPath: request.functionPath,
        projectRoot: request.projectRoot,
        artifactSha256: request.options.attestation?.artifact_sha256,
        bytecode: request.options.bytecode,
      });
      const tlsPolicy = await this.resolveTlsPolicy(request.env);
      return this.waitForWorkerPreheat({
        ...request, options: { ...request.options, bytecodeArtifact },
      }, tlsPolicy);
    } catch (error) {
      return this.failedPreheat(
        request,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  preheat(
    functionId: string,
    functionPath: string,
    projectRoot: string,
    env: Record<string, string>,
    options: PreheatOptions,
  ): Promise<boolean> {
    if (this.draining || this.admissionBlocked || this.admissionRecovering) {
      return Promise.resolve(false);
    }
    const projectRef = options.projectRef;
    const worker = this.takeIdleWorker(projectRef);
    if (!worker) {
      return Promise.resolve(false);
    }

    return this.preheatWorker({ worker, functionId, functionPath, projectRoot, env, options })
      .then((result) => result.success)
      .finally(() => {
        if (!this.draining && this.activeWorkers.has(worker)) {
          this.recycle(worker);
        }
      });
  }

  preheatVersionedIdleWorkers(
    request: VersionedPreheatRequest,
  ): Promise<WorkerPoolVersionPreheatResult> {
    return this.enqueueBulkPreheat(() => this.rotateAndPreheatVersion(request));
  }

  preheatReleaseIdleWorkers(
    requests: readonly VersionedPreheatRequest[],
  ): Promise<WorkerPoolVersionPreheatResult[]> {
    const first = requests[0];
    if (!first || requests.length > 128
      || new Set(requests.map(request => request.functionId)).size !== requests.length
      || requests.some(request => request.projectRef !== first.projectRef)) {
      return Promise.reject(new Error("Release preheat requires 1-128 distinct functions from one project"));
    }
    return this.enqueueBulkPreheat(async () => {
      const rotation = this.rotateGeneration();
      const workers = this.takeIdleWorkersForProject(first.projectRef, first.maxWorkers);
      try {
        if (workers.length === 0) throw new Error("No workers available for release preheat");
        const prepared: WorkerPoolVersionPreheatResult[] = [];
        // Reserve the workers across members; normal per-worker LRU limits still apply.
        for (const request of requests) {
          const start = performance.now();
          const result = this.recordBulkPreheatResults(await this.preheatWorkers({
            functionId: request.functionId, functionPath: request.functionPath,
            projectRoot: request.projectRoot, env: request.env,
            options: {
              projectRef: request.projectRef, moduleVersion: request.moduleVersion,
              envProof: request.envProof, attestation: request.attestation,
              bytecode: request.bytecode,
            },
          }, workers), start);
          if (result.succeeded !== workers.length || result.attestation === null) {
            throw new Error(result.error ?? "Release member preheat was not attested");
          }
          prepared.push({ ...result, rotation });
        }
        if (this.generation !== rotation.generation) throw new Error("Runtime pool changed during release preheat");
        return prepared;
      } finally {
        this.recycleBulkPreheatWorkers(workers);
      }
    });
  }

  private async rotateAndPreheatVersion(
    request: VersionedPreheatRequest,
  ): Promise<WorkerPoolVersionPreheatResult> {
    const rotation = this.rotateGeneration();
    const preheat = await this.preheatIdleWorkersNow({
      functionId: request.functionId,
      functionPath: request.functionPath,
      projectRoot: request.projectRoot,
      env: request.env,
      options: {
        projectRef: request.projectRef,
        moduleVersion: request.moduleVersion,
        envProof: request.envProof,
        attestation: request.attestation,
        bytecode: request.bytecode,
        maxWorkers: request.maxWorkers,
      },
    });
    return { ...preheat, rotation };
  }

  preheatIdleWorkers(
    functionId: string,
    functionPath: string,
    projectRoot: string,
    env: Record<string, string>,
    options: PreheatOptions,
  ): Promise<WorkerPoolPreheatResult> {
    return this.enqueueBulkPreheat(() => this.preheatIdleWorkersNow({
      functionId,
      functionPath,
      projectRoot,
      env,
      options,
    }));
  }

  private enqueueBulkPreheat<T>(operation: () => Promise<T>): Promise<T> {
    const deferredOperation = () => {
      if (this.draining || this.admissionBlocked || this.admissionRecovering) {
        return Promise.reject<T>(new Error("Runtime admission does not allow preheat"));
      }
      return this.runWithDeferredRecycleNotification(operation);
    };
    const queuedOperation = this.bulkPreheatTail
      ? this.bulkPreheatTail.then(deferredOperation)
      : deferredOperation();
    const settledOperation = queuedOperation.then(() => undefined, () => undefined);
    this.bulkPreheatTail = settledOperation;
    void settledOperation.then(() => {
      if (this.bulkPreheatTail === settledOperation) this.bulkPreheatTail = null;
    });
    return queuedOperation;
  }

  private async runWithDeferredRecycleNotification<T>(operation: () => Promise<T>): Promise<T> {
    this.workerRecycleNotificationDeferred = true;
    try {
      return await operation();
    } finally {
      this.workerRecycleNotificationDeferred = false;
      this.notifyWorkerRecycleRequired();
    }
  }

  private async preheatIdleWorkersNow(request: BulkPreheatRequest): Promise<WorkerPoolPreheatResult> {
    const start = performance.now();
    const workers = this.takeIdleWorkersForProject(
      request.options.projectRef,
      request.options.maxWorkers,
    );
    if (workers.length === 0) {
      return {
        attempted: 0,
        succeeded: 0,
        cacheHits: 0,
        cacheMisses: 0,
        durationMs: 0,
        attestation: null,
      };
    }

    try {
      const results = await this.preheatWorkers(request, workers);
      return this.recordBulkPreheatResults(results, start);
    } finally {
      this.recycleBulkPreheatWorkers(workers);
    }
  }

  private preheatWorkers(
    request: BulkPreheatRequest,
    workers: Worker[],
  ): Promise<WorkerPreheatResult[]> {
    return Promise.all(workers.map((worker) => this.preheatWorker({ ...request, worker })));
  }

  private takeIdleWorkersForProject(projectRef: string, maxWorkers?: number): Worker[] {
    const requested = this.requestedPreheatWorkers(maxWorkers);
    const matchingCount = this.idle.filter(
      (worker) => this.workerAcceptsProject(worker, projectRef) && !this.tainted.has(worker),
    ).length;
    this.replaceMismatchedIdleWorkers(projectRef, requested - matchingCount);

    const available = this.idle.filter(
      (worker) => this.workerAcceptsProject(worker, projectRef) && !this.tainted.has(worker),
    );
    const workers = available.slice(0, requested);
    const selected = new Set(workers);
    this.idle = this.idle.filter((worker) => !selected.has(worker));
    return workers;
  }

  private requestedPreheatWorkers(maxWorkers?: number): number {
    if (!maxWorkers || maxWorkers <= 0) return this.idle.length;
    return Math.min(maxWorkers, this.idle.length);
  }

  private replaceMismatchedIdleWorkers(projectRef: string, missingWorkers: number): void {
    const replacementCount = Math.max(0, missingWorkers);
    const mismatched = this.idle.filter(
      (worker) => !this.workerAcceptsProject(worker, projectRef),
    ).slice(0, replacementCount);
    for (const worker of mismatched) {
      const replacement = this.switchProjectSlot(worker, projectRef);
      this.idle.push(replacement);
    }
  }

  private recordBulkPreheatResults(
    results: WorkerPreheatResult[],
    start: number,
  ): WorkerPoolPreheatResult {
    const durationMs = Math.round(performance.now() - start);
    const succeeded = results.filter((result) => result.success).length;
    const allWorkersAttested = results.length > 0
      && results.every((result) => result.success && result.attestation !== null);
    this.totalPreheatAttempts += results.length;
    this.totalPreheatSucceeded += succeeded;
    this.totalPreheatMs += durationMs;
    return {
      attempted: results.length,
      succeeded,
      cacheHits: results.filter((result) => result.cacheHit === true).length,
      cacheMisses: results.filter((result) => result.cacheHit === false).length,
      durationMs,
      attestation: allWorkersAttested ? results[0]!.attestation : null,
      error: results.find((result) => !result.success && result.error)?.error,
    };
  }

  private recycleBulkPreheatWorkers(workers: Worker[]): void {
    if (this.draining) return;
    for (const worker of workers) {
      if (this.activeWorkers.has(worker)) this.recycle(worker);
    }
  }

  snapshotMetrics(prefix = "supacloud_edge"): Record<string, number> {
    return {
      [`${prefix}_worker_heap_bytes`]: [...this.workerMemory.values()].reduce((sum, item) => sum + item.heapSize, 0),
      [`${prefix}_worker_heap_capacity_bytes`]: [...this.workerMemory.values()].reduce((sum, item) => sum + item.heapCapacity, 0),
      [`${prefix}_worker_extra_memory_bytes`]: [...this.workerMemory.values()].reduce((sum, item) => sum + item.extraMemorySize, 0),
      [`${prefix}_memory_retirements`]: this.memoryRetirements,
      [`${prefix}_active_workers`]: this.activeWorkers.size - this.idle.length,
      [`${prefix}_idle_workers`]: this.idle.length,
      [`${prefix}_parked_workers`]: this.parkedWorkers.size,
      [`${prefix}_total_workers`]: this.activeWorkers.size + this.parkedWorkers.size,
      [`${prefix}_max_project_workers`]: this.maxWorkers,
      [`${prefix}_max_concurrent_executions`]: this.maxConcurrentExecutions,
      [`${prefix}_total_worker_surplus_creations`]: this.totalWorkerSurplusCreations,
      [`${prefix}_total_worker_surplus_retirements`]: this.totalWorkerSurplusRetirements,
      [`${prefix}_total_project_affinity_hits`]: this.totalProjectAffinityHits,
      [`${prefix}_total_parked_worker_reuses`]: this.totalParkedWorkerReuses,
      [`${prefix}_total_project_worker_evictions`]: this.totalProjectWorkerEvictions,
      [`${prefix}_total_worker_create_ms`]: this.totalWorkerCreateMs,
      [`${prefix}_worker_smol`]: this.config.smol ? 1 : 0,
      [`${prefix}_queue_length`]: this.queuedCount,
      [`${prefix}_response_deliveries`]: this.responseDeliveries.size,
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
      [`${prefix}_max_worker_replacements_before_recycle`]: this.maxWorkerReplacementsBeforeRecycle,
      [`${prefix}_worker_recycle_required`]: this.workerRecycleRequired ? 1 : 0,
      [`${prefix}_retired_workers`]: this.retiredWorkers.size,
      [`${prefix}_total_worker_retirements`]: this.totalWorkerRetirements,
      [`${prefix}_total_natural_worker_exits`]: this.totalNaturalWorkerExits,
      [`${prefix}_worker_generation`]: this.workerGeneration,
      [`${prefix}_total_generation_rotations`]: this.totalGenerationRotations,
      [`${prefix}_total_generation_idle_retirements`]: this.totalGenerationIdleRetirements,
      [`${prefix}_total_generation_busy_taints`]: this.totalGenerationBusyTaints,
      [`${prefix}_oldest_retired_worker_age_ms`]: this.oldestRetirementAgeMs(),
      [`${prefix}_retirement_budget_exceeded`]: this.retirementBudgetExceeded ? 1 : 0,
      [`${prefix}_total_preheat_attempts`]: this.totalPreheatAttempts,
      [`${prefix}_total_preheat_succeeded`]: this.totalPreheatSucceeded,
      [`${prefix}_total_preheat_ms`]: this.totalPreheatMs,
      [`${prefix}_avg_env_load_ms`]: this.totalRequests > 0 ? Math.round(this.totalEnvLoadMs / this.totalRequests) : 0,
      [`${prefix}_avg_queue_wait_ms`]: this.totalRequests > 0 ? Math.round(this.totalQueueWaitMs / this.totalRequests) : 0,
      [`${prefix}_total_queued_requests`]: this.totalQueuedRequests,
      [`${prefix}_admission_blocked`]: this.admissionBlocked ? 1 : 0,
      [`${prefix}_admission_recovering`]: this.admissionRecovering ? 1 : 0,
      [`${prefix}_total_admission_rejected`]: this.totalAdmissionRejected,
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

  get generation(): number {
    return this.workerGeneration;
  }

  async drain(): Promise<void> {
    this.stopDispatching();
    while (this.bulkPreheatTail) {
      await this.bulkPreheatTail;
    }

    if (this.inFlight.size === 0 && this.responseDeliveries.size === 0) return;

    await new Promise<void>((resolve) => {
      const check = () => {
        if (this.inFlight.size === 0 && this.responseDeliveries.size === 0) {
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
      for (const fail of this.responseDeliveries.values()) fail(new Error("Runtime is shutting down"));
    }
    for (const worker of [...this.activeWorkers, ...this.parkedWorkers]) {
      this.retireWorker(worker);
    }
    await Bun.sleep(0);
  }
}
