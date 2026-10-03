/** Explicit, bounded in-process work accounting. Not a durable queue or scheduler. */
export type WorkKind = "startup" | "request" | "job" | "shutdown" | "background";
export interface WorkDescription { name: string; kind: WorkKind; }
export interface PendingWorkSnapshot extends WorkDescription {
  readonly id: number;
  readonly ageMs: number;
  readonly blocking: boolean;
}
export interface WorkRegistryOptions { capacity?: number; signal?: AbortSignal; }
export interface WorkWaitOptions { timeoutMs?: number; signal?: AbortSignal; includeBackground?: boolean; }
export interface WorkOwner {
  readonly signal?: AbortSignal;
  readonly destroyed?: boolean;
  onDestroy(callback: () => void | Promise<void>): () => void;
}

export class PendingWorkTimeoutError extends Error {
  readonly code = "PENDING_WORK_TIMEOUT";
  constructor(readonly pending: readonly PendingWorkSnapshot[]) {
    super("Timed out waiting for registered work; inspect pending metadata.");
    this.name = "PendingWorkTimeoutError";
  }
}

export class PendingWorkCapacityError extends RangeError {
  readonly code = "PENDING_WORK_CAPACITY_EXCEEDED";
  constructor() {
    super("Work registry capacity exceeded");
    this.name = "PendingWorkCapacityError";
  }
}

/** The caller owns the registry. Unfinished work remains visible after cancellation. */
export class PendingWorkRegistry {
  private readonly entries = new Map<number, WorkDescription & { started: number }>();
  private readonly waiters = new Set<() => void>();
  private readonly controller = new AbortController();
  private readonly capacity: number;
  private sequence = 0;
  private accepting = true;
  private detachOwner: (() => void) | undefined;

  constructor(options: WorkRegistryOptions = {}) {
    const capacity = options.capacity ?? 1024;
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 65536) {
      throw new RangeError("Work registry capacity must be an integer in 1..65536");
    }
    this.capacity = capacity;
    const owner = options.signal;
    if (owner) {
      const abort = () => this.dispose(owner.reason);
      this.detachOwner = () => owner.removeEventListener("abort", abort);
      owner.addEventListener("abort", abort, { once: true });
      if (owner.aborted) abort();
    }
  }

  get signal(): AbortSignal { return this.controller.signal; }
  get closed(): boolean { return !this.accepting; }

  /** Add immediately before starting work; the returned completion is idempotent. */
  add(description: WorkDescription): () => void {
    if (!this.accepting) throw new Error("Work registry is closed");
    if (!description || !/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(description.name)
      || !["startup", "request", "job", "shutdown", "background"].includes(description.kind)) {
      throw new TypeError("Use a bounded operation name and a supported work kind; never include request data");
    }
    if (this.entries.size >= this.capacity) throw new PendingWorkCapacityError();
    const id = ++this.sequence;
    this.entries.set(id, { name: description.name, kind: description.kind, started: performance.now() });
    return () => {
      if (!this.entries.delete(id)) return;
      for (const notify of [...this.waiters]) notify();
    };
  }

  /** Preserves the actual result or original rejection, and observes synchronous throws. */
  async run<T>(description: WorkDescription, work: (signal: AbortSignal) => T | PromiseLike<T>): Promise<T> {
    const complete = this.add(description);
    try { return await work(this.signal); }
    finally { complete(); }
  }

  snapshot(): readonly PendingWorkSnapshot[] {
    const now = performance.now();
    return [...this.entries].map(([id, entry]) => ({
      id, name: entry.name, kind: entry.kind,
      ageMs: Math.max(0, now - entry.started), blocking: entry.kind !== "background",
    }));
  }

  /** Stop admitting work without pretending that existing work has finished. */
  close(): void { this.accepting = false; }

  /** Request cooperative cancellation; this never deletes unfinished registrations. */
  dispose(reason?: unknown): void {
    this.close();
    this.detachOwner?.();
    this.detachOwner = undefined;
    if (!this.signal.aborted) this.controller.abort(reason);
  }

  /** A bounded idle observation, not a guarantee that new work cannot arrive afterward. */
  waitForIdle(options: WorkWaitOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
      return Promise.reject(new RangeError("Invalid work wait timeout"));
    }
    const signal = options.signal;
    const pending = () => this.snapshot().filter(entry => options.includeBackground === true || entry.blocking);
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Wait aborted", "AbortError"));
    if (pending().length === 0) return Promise.resolve();
    if (this.waiters.size >= this.capacity) return Promise.reject(new RangeError("Work waiter capacity exceeded"));
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown, failed = false) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.waiters.delete(check);
        if (failed) reject(error); else resolve();
      };
      const check = () => { if (pending().length === 0) finish(); };
      const abort = () => finish(signal?.reason ?? new DOMException("Wait aborted", "AbortError"), true);
      this.waiters.add(check);
      timer = setTimeout(() => finish(new PendingWorkTimeoutError(pending()), true), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort(); else check();
    });
  }
}

/** Bind bookkeeping to an explicit request/job/application owner, never a global singleton. */
export function createPendingWorkRegistry(owner: WorkOwner, options: Omit<WorkRegistryOptions, "signal"> = {}): PendingWorkRegistry {
  const registry = new PendingWorkRegistry({ ...options, signal: owner.signal });
  if (owner.destroyed || owner.signal?.aborted) { registry.dispose(); return registry; }
  let unregister: () => void;
  try { unregister = owner.onDestroy(() => registry.dispose()); }
  catch (error) { registry.dispose(); throw error; }
  // Already-admitted work retains its own completion; owner disposal only requests cancellation.
  registry.signal.addEventListener("abort", unregister, { once: true });
  if (registry.signal.aborted) unregister();
  return registry;
}
