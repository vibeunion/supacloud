import {
  executeJob,
  type CompiledJob,
  type CompiledModule,
  type ExecutionObserver,
  type JobExecutor,
} from "./index";

export type WorkerState = "idle" | "starting" | "running" | "stopping" | "stopped";

/** The transport-specific claim is mapped to this small execution contract. */
export interface WorkerClaim {
  id: string;
  jobName: string;
  input: unknown;
  attempt?: number;
  requestContext?: unknown;
}

export interface WorkerReceiptContext {
  readonly jobId: string;
  readonly jobName: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
}

export type WorkerAcknowledge<TClaim, TReceipt> = (
  claim: TClaim,
  output: unknown,
  context: WorkerReceiptContext,
) => TReceipt | Promise<TReceipt>;

export type WorkerFail<TClaim, TReceipt> = (
  claim: TClaim,
  error: unknown,
  context: WorkerReceiptContext,
) => TReceipt | Promise<TReceipt>;

/** Minimal queue message shape shared by the public SupaCloud queue client. */
export interface WorkerQueueMessage {
  id: string | number;
  payload: unknown;
}

export interface WorkerQueueReceiveOptions {
  visibilityTimeoutSec?: number;
  sleepSeconds?: number;
  sleep_seconds?: number;
}

export interface WorkerQueueFailureOptions {
  error?: string;
  deadLetter?: boolean;
}

/** Structural port implemented by `client.queue(name)` without a package dependency. */
export interface WorkerQueuePort<
  TMessage extends WorkerQueueMessage = WorkerQueueMessage,
  TReceipt = unknown,
> {
  receive(options?: WorkerQueueReceiveOptions): Promise<TMessage | null>;
  ack(messageId: string | number): TReceipt | Promise<TReceipt>;
  fail(messageId: string | number, options?: WorkerQueueFailureOptions): TReceipt | Promise<TReceipt>;
}

export interface QueueWorkerTransportOptions<
  TMessage extends WorkerQueueMessage,
  TClaim,
  TReceipt,
> {
  queue: WorkerQueuePort<TMessage, TReceipt>;
  decodeClaim: (message: TMessage) => TClaim;
  messageId: (claim: TClaim) => string | number;
  receive?: WorkerQueueReceiveOptions;
}

function workerFailureMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string" ? error : "Worker job failed";
  const normalized = message.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return (normalized || "Worker job failed").slice(0, 4096);
}

/**
 * Adapts the existing SupaCloud queue client to the worker transport contract.
 * Queue leasing and retry policy remain owned by the queue implementation.
 */
export function createQueueWorkerTransport<
  TMessage extends WorkerQueueMessage,
  TClaim,
  TReceipt,
>(options: QueueWorkerTransportOptions<TMessage, TClaim, TReceipt>): WorkerTransport<TClaim, TReceipt> {
  if (!options.queue || typeof options.queue.receive !== "function"
    || typeof options.queue.ack !== "function" || typeof options.queue.fail !== "function"
    || typeof options.decodeClaim !== "function" || typeof options.messageId !== "function") {
    throw new TypeError("Queue worker transport requires queue, decodeClaim and messageId");
  }
  const receiveOptions = options.receive === undefined ? undefined : { ...options.receive };
  return {
    claim: async (signal) => {
      signal.throwIfAborted();
      const message = await options.queue.receive(receiveOptions);
      signal.throwIfAborted();
      return message === null ? null : options.decodeClaim(message);
    },
    ack: (claim) => options.queue.ack(options.messageId(claim)),
    fail: (claim, error) => options.queue.fail(options.messageId(claim), {
      error: workerFailureMessage(error),
    }),
  };
}

/**
 * Queue/task ownership stays in the host adapter. The worker never interprets
 * a receipt and therefore supports platform-specific receipt types unchanged.
 */
export interface WorkerTransport<TClaim = WorkerClaim, TReceipt = unknown> {
  claim(signal: AbortSignal): Promise<TClaim | null>;
  /** Preferred spelling. */
  ack?: WorkerAcknowledge<TClaim, TReceipt>;
  /** Compatibility spelling for adapters that use the full verb. */
  acknowledge?: WorkerAcknowledge<TClaim, TReceipt>;
  fail: WorkerFail<TClaim, TReceipt>;
}

export interface WorkerRunResult<TReceipt> {
  claimId: string;
  jobName: string;
  status: "acknowledged" | "failed";
  receipt: TReceipt;
}

export interface WorkerOptions<TClaim = WorkerClaim, TReceipt = unknown> {
  modules?: readonly CompiledModule[];
  deps?: Record<string, unknown>;
  transport: WorkerTransport<TClaim, TReceipt>;
  /** Convert a platform claim into the framework's stable execution shape. */
  mapClaim?: (claim: TClaim) => WorkerClaim;
  /** Build a request-like context for the Job. */
  requestContext?: (
    claim: WorkerClaim,
    signal: AbortSignal,
  ) => unknown | Promise<unknown>;
  workerId?: string;
  concurrency?: number;
  pollIntervalMs?: number;
  executor?: JobExecutor;
  onExecution?: ExecutionObserver;
  onError?: (error: unknown) => void | Promise<void>;
  /** Optional application-service cleanup owned by the host/bootstrap. */
  destroyServices?: (
    services: Record<string, unknown>,
    imported: Record<string, Record<string, unknown>>,
  ) => void | Promise<void>;
}

export class WorkerRegistrationError extends Error {
  readonly code:
    | "WORKER_DUPLICATE_JOB"
    | "WORKER_DUPLICATE_MODULE"
    | "WORKER_INVALID_JOB"
    | "WORKER_TRANSPORT_INVALID"
    | "WORKER_NOT_STARTED";

  constructor(
    code: WorkerRegistrationError["code"],
    message: string,
  ) {
    super(message);
    this.name = "WorkerRegistrationError";
    this.code = code;
  }
}

export type WorkerReceiptOperation = "ack" | "fail";

/** A platform settlement may have applied even when its response was lost. */
export class WorkerReceiptUnconfirmedError extends Error {
  readonly code = "WORKER_RECEIPT_UNCONFIRMED" as const;
  readonly mutationMayHaveApplied = true as const;

  constructor(
    readonly operation: WorkerReceiptOperation,
    readonly claimId: string,
  ) {
    super(`Worker ${operation} receipt could not be confirmed for claim "${claimId}"`);
    this.name = "WorkerReceiptUnconfirmedError";
  }
}

function safeWorkerId(value: string | undefined): string {
  const workerId = value ?? `worker-${crypto.randomUUID()}`;
  if (workerId.length === 0 || workerId.length > 256 || /[\u0000-\u001f\u007f]/.test(workerId)) {
    throw new TypeError("Worker workerId must be a safe non-empty string");
  }
  return workerId;
}

function safeDescriptorText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validJobScope(value: unknown): value is CompiledJob["scope"] {
  return value === "application" || value === "request" || value === "job";
}

function validJobMode(value: unknown): value is NonNullable<CompiledJob["mode"]> {
  return value === "task" || value === "workflow";
}

function validJobIdempotency(value: unknown): value is NonNullable<CompiledJob["idempotency"]> {
  return value === "required" || value === "none";
}

function validPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function safeClaim(claim: WorkerClaim): WorkerClaim {
  if (!claim || typeof claim !== "object") {
    throw new WorkerRegistrationError("WORKER_INVALID_JOB", "Worker claim is invalid");
  }
  if (typeof claim.id !== "string" || claim.id.length === 0 || claim.id.length > 512
    || /[\u0000-\u001f\u007f]/.test(claim.id)
    || typeof claim.jobName !== "string" || claim.jobName.length === 0
    || claim.jobName.length > 256 || /[\u0000-\u001f\u007f]/.test(claim.jobName)) {
    throw new WorkerRegistrationError("WORKER_INVALID_JOB", "Worker claim identity is invalid");
  }
  const attempt = claim.attempt ?? 1;
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new WorkerRegistrationError("WORKER_INVALID_JOB", "Worker claim attempt is invalid");
  }
  return { ...claim, attempt };
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal.reason ?? new DOMException("Aborted", "AbortError")));
    const timer = setTimeout(() => finish(resolve), milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function destroyServiceValues(services: Record<string, unknown>): Promise<void> {
  const errors: unknown[] = [];
  const seen = new Set<unknown>();
  for (const value of Object.values(services).reverse()) {
    if (seen.has(value) || !value || typeof value !== "object") continue;
    seen.add(value);
    const candidate = value as { onDestroy?: unknown; ngOnDestroy?: unknown };
    const hook = typeof candidate.onDestroy === "function"
      ? candidate.onDestroy
      : typeof candidate.ngOnDestroy === "function" ? candidate.ngOnDestroy : undefined;
    if (!hook) continue;
    try {
      await Reflect.apply(hook, value, []);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Worker service destruction failed");
}

/**
 * Registers compiler-emitted Jobs and drives an existing claim/receipt
 * transport. It deliberately does not implement queue leasing, retries, or
 * DLQ policy; those are properties of the platform adapter.
 */
export class SupaCloudWorker<TClaim = WorkerClaim, TReceipt = unknown> {
  private readonly registry = new Map<string, { module: CompiledModule; job: CompiledJob }>();
  private readonly modules: CompiledModule[] = [];
  private readonly moduleServices = new Map<string, Record<string, unknown>>();
  private readonly deps: Record<string, unknown>;
  private readonly transport: WorkerTransport<TClaim, TReceipt>;
  private readonly mapClaim: (claim: TClaim) => WorkerClaim;
  private readonly requestContextFactory: NonNullable<WorkerOptions<TClaim, TReceipt>["requestContext"]>;
  private readonly workerId: string;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly executor: JobExecutor | undefined;
  private readonly observer: ExecutionObserver | undefined;
  private readonly onError: ((error: unknown) => void | Promise<void>) | undefined;
  private readonly destroyServices: WorkerOptions<TClaim, TReceipt>["destroyServices"] | undefined;
  private stateValue: WorkerState = "idle";
  private claimController: AbortController | undefined;
  private loopPromise: Promise<void> | undefined;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private stopRequested = false;
  private readonly inFlight = new Set<Promise<unknown>>();
  private services: Record<string, unknown> = {};
  private imported: Record<string, Record<string, unknown>> = {};

  constructor(options: WorkerOptions<TClaim, TReceipt>) {
    if (!options.transport || typeof options.transport.claim !== "function"
      || typeof options.transport.fail !== "function"
      || (typeof options.transport.ack !== "function" && typeof options.transport.acknowledge !== "function")) {
      throw new WorkerRegistrationError("WORKER_TRANSPORT_INVALID", "Worker transport must provide claim, ack and fail");
    }
    this.transport = options.transport;
    this.deps = options.deps ?? {};
    this.workerId = safeWorkerId(options.workerId);
    this.mapClaim = options.mapClaim ?? ((claim) => claim as unknown as WorkerClaim);
    this.requestContextFactory = options.requestContext ?? ((claim, signal) => ({
      workerId: this.workerId,
      jobId: claim.id,
      jobName: claim.jobName,
      attempt: claim.attempt,
      signal,
    }));
    this.concurrency = this.capturePositiveInteger(options.concurrency, 1, 1000, "concurrency");
    this.pollIntervalMs = this.captureNonNegativeInteger(options.pollIntervalMs, 1000, 300_000, "pollIntervalMs");
    this.executor = options.executor;
    this.observer = options.onExecution;
    this.onError = options.onError;
    this.destroyServices = options.destroyServices;
    for (const module of options.modules ?? []) this.registerModule(module);
  }

  get state(): WorkerState {
    return this.stateValue;
  }

  get id(): string {
    return this.workerId;
  }

  get jobNames(): readonly string[] {
    return Object.freeze([...this.registry.keys()]);
  }

  get jobs(): readonly CompiledJob[] {
    return Object.freeze([...this.registry.values()].map((entry) => entry.job));
  }

  /** Register a compiled module before the worker starts. */
  registerModule(module: CompiledModule): void {
    if (this.stateValue !== "idle" && this.stateValue !== "stopped") {
      throw new WorkerRegistrationError("WORKER_INVALID_JOB", "Jobs cannot be registered while the worker is active");
    }
    if (!module || typeof module !== "object" || typeof module.name !== "string"
      || module.name.length === 0 || module.name.length > 256
      || /[\u0000-\u001f\u007f]/.test(module.name)
      || typeof module.createServices !== "function"
      || (module.jobs !== undefined && !Array.isArray(module.jobs))) {
      throw new WorkerRegistrationError("WORKER_INVALID_JOB", "A registered module is invalid");
    }
    if (this.modules.some((candidate) => candidate.name === module.name)) {
      throw new WorkerRegistrationError("WORKER_DUPLICATE_MODULE", `Module "${module.name}" is registered more than once`);
    }
    const jobs = module.jobs ?? [];
    const names = new Set<string>();
    for (const job of jobs) {
      if (!job || typeof job !== "object"
        || !safeDescriptorText(job.className, 256)
        || !safeDescriptorText(job.name, 256)
        || !safeDescriptorText(job.serviceKey, 256)
        || !validJobScope(job.scope)
        || (job.mode !== undefined && !validJobMode(job.mode))
        || (job.idempotency !== undefined && !validJobIdempotency(job.idempotency))
        || (job.timeoutSec !== undefined && !validPositiveInteger(job.timeoutSec))
        || (job.maxAttempts !== undefined && !validPositiveInteger(job.maxAttempts))) {
        throw new WorkerRegistrationError(
          "WORKER_INVALID_JOB",
          "A registered Job has invalid identity or execution metadata",
        );
      }
      if (this.registry.has(job.name) || names.has(job.name)) {
        throw new WorkerRegistrationError("WORKER_DUPLICATE_JOB", `Job "${job.name}" is registered more than once`);
      }
      names.add(job.name);
    }
    this.modules.push(module);
    for (const job of jobs) this.registry.set(job.name, { module, job });
  }

  /** Alias useful for hosts that register generated modules incrementally. */
  register(module: CompiledModule): void {
    this.registerModule(module);
  }

  async start(): Promise<void> {
    if (this.stateValue === "running") return;
    if (this.stateValue === "starting" && this.startPromise) return this.startPromise;
    if (this.stateValue === "stopping" && this.stopPromise) await this.stopPromise;

    this.stopRequested = false;
    this.stateValue = "starting";
    const startPromise = Promise.resolve().then(() => this.initialize()).then(async () => {
      if (this.stopRequested || this.stateValue !== "starting") {
        await this.releaseServices();
        return;
      }
      this.claimController = new AbortController();
      this.stateValue = "running";
      this.loopPromise = this.pollLoop(this.claimController.signal);
    }).catch(async (error: unknown) => {
      this.stateValue = "stopped";
      await this.releaseServices();
      throw error;
    });
    this.startPromise = startPromise;
    return startPromise;
  }

  async stop(): Promise<void> {
    if (this.stateValue === "idle" || this.stateValue === "stopped") return;
    if (this.stopPromise) return this.stopPromise;
    this.stopRequested = true;
    this.stateValue = "stopping";
    this.claimController?.abort(new DOMException("Worker stopped", "AbortError"));
    const startPromise = this.startPromise;
    this.stopPromise = (async () => {
      await startPromise?.catch(() => undefined);
      await this.loopPromise?.catch((error: unknown) => this.reportError(error));
      await Promise.allSettled([...this.inFlight]);
      await this.releaseServices();
      this.stateValue = "stopped";
      this.claimController = undefined;
      this.loopPromise = undefined;
      this.startPromise = undefined;
      this.stopPromise = undefined;
    })();
    return this.stopPromise;
  }

  /** Claim and process one item, primarily useful for deterministic hosts/tests. */
  async runOnce(): Promise<WorkerRunResult<TReceipt> | null> {
    if (this.stateValue !== "running") {
      throw new WorkerRegistrationError("WORKER_NOT_STARTED", "Worker must be started before runOnce");
    }
    const controller = this.claimController;
    if (!controller) throw new WorkerRegistrationError("WORKER_NOT_STARTED", "Worker claim lifecycle is unavailable");
    controller.signal.throwIfAborted();
    const claim = await this.transport.claim(controller.signal);
    if (claim === null) return null;
    return this.processClaim(claim);
  }

  /** Process a host-provided claim without performing another claim operation. */
  async processClaim(rawClaim: TClaim): Promise<WorkerRunResult<TReceipt>> {
    const claim = safeClaim(this.mapClaim(rawClaim));
    const entry = this.registry.get(claim.jobName);
    const controller = new AbortController();
    const context: WorkerReceiptContext = Object.freeze({
      jobId: claim.id,
      jobName: claim.jobName,
      attempt: claim.attempt ?? 1,
      signal: controller.signal,
    });
    if (!entry) {
      const receipt = await this.failClaim(rawClaim, claim, new WorkerRegistrationError(
        "WORKER_INVALID_JOB", `Job "${claim.jobName}" is not registered`,
      ), context);
      return { claimId: claim.id, jobName: claim.jobName, status: "failed", receipt };
    }

    let output: unknown;
    try {
      if (this.stateValue !== "running" && this.stateValue !== "stopping") {
        throw new WorkerRegistrationError("WORKER_NOT_STARTED", "Worker is not active");
      }
      const requestContext = claim.requestContext ?? await this.requestContextFactory(claim, controller.signal);
      const moduleServices = this.moduleServices.get(entry.module.name);
      if (!moduleServices) throw new WorkerRegistrationError("WORKER_NOT_STARTED", "Worker services are unavailable");
      output = await executeJob(
        entry.module,
        moduleServices,
        entry.job,
        claim.input,
        requestContext,
        this.imported,
        this.executor,
        this.observer,
      );
    } catch (error) {
      const receipt = await this.failClaim(rawClaim, claim, error, context);
      return { claimId: claim.id, jobName: claim.jobName, status: "failed", receipt };
    }

    const acknowledge = this.transport.ack ?? this.transport.acknowledge;
    if (!acknowledge) throw new WorkerRegistrationError("WORKER_TRANSPORT_INVALID", "Worker acknowledgement is unavailable");
    try {
      const receipt = await acknowledge(rawClaim, output, context);
      return { claimId: claim.id, jobName: claim.jobName, status: "acknowledged", receipt };
    } catch {
      throw new WorkerReceiptUnconfirmedError("ack", claim.id);
    }
  }

  private async failClaim(
    rawClaim: TClaim,
    claim: WorkerClaim,
    error: unknown,
    context: WorkerReceiptContext,
  ): Promise<TReceipt> {
    try {
      return await this.transport.fail(rawClaim, error, context);
    } catch {
      throw new WorkerReceiptUnconfirmedError("fail", claim.id);
    }
  }

  private async initialize(): Promise<void> {
    this.services = {};
    this.imported = {};
    this.moduleServices.clear();
    for (const module of this.modules) {
      const services = module.createServices(this.deps, this.imported);
      this.moduleServices.set(module.name, services);
      this.services = { ...this.services, ...services };
      this.imported[module.name] = services;
    }
  }

  private async releaseServices(): Promise<void> {
    const services = this.services;
    const imported = this.imported;
    this.services = {};
    this.imported = {};
    this.moduleServices.clear();
    if (Object.keys(services).length === 0) return;
    try {
      if (this.destroyServices) await this.destroyServices(services, imported);
      else await destroyServiceValues(services);
    } catch (error) {
      await this.reportError(error);
    }
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.stateValue === "running") {
      if (this.inFlight.size >= this.concurrency) {
        await Promise.race(this.inFlight).catch((error: unknown) => this.reportError(error));
        continue;
      }
      let claim: TClaim | null;
      try {
        claim = await this.transport.claim(signal);
      } catch (error) {
        if (signal.aborted) break;
        await this.reportError(error);
        await delay(this.pollIntervalMs, signal).catch(() => undefined);
        continue;
      }
      if (claim === null) {
        await delay(this.pollIntervalMs, signal).catch(() => undefined);
        continue;
      }
      const execution = this.processClaim(claim).catch((error: unknown) => this.reportError(error));
      this.inFlight.add(execution);
      void execution.finally(() => this.inFlight.delete(execution));
    }
  }

  private async reportError(error: unknown): Promise<void> {
    try {
      await this.onError?.(error);
    } catch {
      // Error observers must not stop claim processing or shutdown.
    }
  }

  private capturePositiveInteger(value: number | undefined, fallback: number, max: number, name: string): number {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new TypeError(`Worker ${name} is invalid`);
    return result;
  }

  private captureNonNegativeInteger(value: number | undefined, fallback: number, max: number, name: string): number {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result < 0 || result > max) throw new TypeError(`Worker ${name} is invalid`);
    return result;
  }
}

export function createWorker<TClaim = WorkerClaim, TReceipt = unknown>(
  options: WorkerOptions<TClaim, TReceipt>,
): SupaCloudWorker<TClaim, TReceipt> {
  return new SupaCloudWorker(options);
}
