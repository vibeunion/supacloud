import { MessageChannel } from "node:worker_threads";

export const BODY_CHUNK_BYTES = 512 * 1024;
export const SMALL_BODY_BYTES = 64 * 1024;

export class BodyLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Body exceeded the configured limit of ${limit} bytes`);
    this.name = "BodyLimitError";
  }
}

export class BufferBudgetError extends Error {
  constructor() { super("Runtime body buffer budget exhausted"); }
}

export function positiveBytes(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("Memory budget must be a positive integer in bytes");
  return bytes;
}

/** Logical reservations for runtime-owned body buffers, not a tenant heap limit. */
export class BodyBufferBudget {
  used = 0;
  peak = 0;
  rejected = 0;
  private listeners = new Set<() => void>();
  private notificationPending = false;
  constructor(readonly limit = positiveBytes(process.env.EDGE_BODY_BUFFER_BUDGET_BYTES, 256 * 1024 * 1024)) {}
  onAvailable(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private released() {
    if (this.notificationPending) return;
    this.notificationPending = true;
    queueMicrotask(() => {
      this.notificationPending = false;
      for (const listener of this.listeners) listener();
    });
  }
  lease() {
    let held = 0;
    const tryResize = (bytes: number) => {
      if (this.used - held + bytes > this.limit) return false;
      const previous = held;
      this.used += bytes - held;
      held = bytes;
      this.peak = Math.max(this.peak, this.used);
      if (bytes < previous) this.released();
      return true;
    };
    return {
      canResize: (bytes: number) => this.used - held + bytes <= this.limit,
      tryResize,
      resize: (bytes: number) => {
        if (!tryResize(bytes)) { this.rejected++; throw new BufferBudgetError(); }
      },
      release: () => { tryResize(0); },
    };
  }
}
export type BodyBufferLease = ReturnType<BodyBufferBudget["lease"]>;

// Foreground and background pools share these process-level budgets.
// Response bytes count against both caps, without allocating a second copy.
export const bodyBufferBudget = new BodyBufferBudget();
export const responseBufferBudget = new BodyBufferBudget(
  positiveBytes(process.env.EDGE_RESPONSE_BUFFER_BUDGET_BYTES, 256 * 1024 * 1024),
);

export async function readBoundedBody(
  body: ReadableStream<Uint8Array>, limit: number, signal: AbortSignal,
  reserve: (bytes: number) => void,
): Promise<ArrayBuffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let allocated = 0;
  let pageUsed = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > limit) throw new BodyLimitError(limit);
      let offset = 0;
      while (offset < value.byteLength) {
        let page = chunks.at(-1);
        if (!page || pageUsed === page.byteLength) {
          const capacity = Math.min(BODY_CHUNK_BYTES, limit - allocated);
          // Reserve both pages and the eventual contiguous transfer before allocating.
          reserve((allocated + capacity) * 2);
          page = new Uint8Array(capacity);
          chunks.push(page);
          allocated += capacity;
          pageUsed = 0;
        }
        const bytes = Math.min(page.byteLength - pageUsed, value.byteLength - offset);
        page.set(value.subarray(offset, offset + bytes), pageUsed);
        pageUsed += bytes;
        offset += bytes;
      }
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      const bytes = Math.min(chunk.byteLength, total - offset);
      output.set(chunk.subarray(0, bytes), offset); offset += bytes;
    }
    return output.buffer;
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export function bufferedBody(buffer: ArrayBuffer, options: {
  release: () => void;
  signal: AbortSignal;
  idleTimeoutMs: number;
  onDone: () => void;
}) {
  let bytes: ArrayBuffer | null = buffer;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const finish = () => {
    if (finished) return;
    finished = true;
    bytes = null;
    clearTimeout(timer);
    options.signal.removeEventListener("abort", abort);
    options.release();
    options.onDone();
  };
  const fail = (error: Error) => {
    if (finished) return;
    controller.error(error);
    finish();
  };
  const abort = () => fail(new Error("Function body cancelled"));
  const stream = new ReadableStream<Uint8Array>({
    start(target) {
      controller = target;
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();
      else {
        timer = setTimeout(() => fail(new Error("Function response delivery timed out")), options.idleTimeoutMs);
        timer.unref?.();
      }
    },
    pull() {
      if (bytes) controller.enqueue(new Uint8Array(bytes));
      controller.close();
      finish();
    },
    cancel: finish,
  }, { highWaterMark: 0 });
  return { stream, fail };
}

/** Probe small responses without ever aggregating a large response. */
export async function prepareResponseBody(body: ReadableStream<Uint8Array>, limit: number | undefined, immediate: boolean, signal: AbortSignal) {
  const reader = body.getReader();
  let bytesRead = 0;
  let pending: Uint8Array = new Uint8Array(0);
  let small: Uint8Array[] = [];
  let cancellation: Promise<void> | undefined;
  const cancelReader = (reason: unknown) => cancellation ??= reader.cancel(reason).catch(() => {});
  const abortRead = () => { void cancelReader(signal.reason); };
  signal.addEventListener("abort", abortRead, { once: true });
  const read = async () => {
    signal.throwIfAborted();
    const result = await reader.read();
    signal.throwIfAborted();
    if (!result.done) {
      bytesRead += result.value.byteLength;
      if (limit !== undefined && bytesRead > limit) throw new BodyLimitError(limit);
    }
    return result;
  };
  const closeReader = () => { signal.removeEventListener("abort", abortRead); reader.releaseLock(); };
  try {
    if (!immediate) {
      const probe = new Uint8Array(SMALL_BODY_BYTES);
      let probeBytes = 0;
      while (true) {
        const next = await read();
        if (next.done) {
          closeReader();
          return { buffer: probe.slice(0, probeBytes).buffer };
        }
        if (bytesRead > SMALL_BODY_BYTES) {
          if (probeBytes) small.push(probe.subarray(0, probeBytes));
          pending = next.value;
          break;
        }
        probe.set(next.value, probeBytes);
        probeBytes += next.value.byteLength;
      }
    }
  } catch (error) {
    await cancelReader(error);
    closeReader();
    throw error;
  }

  const { port1, port2 } = new MessageChannel();
  const run = async () => {
    let credit: (() => void) | undefined;
    let available = false;
    let cancelled = false;
    const wake = () => { if (credit) { const resolve = credit; credit = undefined; resolve(); } else available = true; };
    const abort = () => {
      cancelled = true;
      wake();
      // Closing a port must also wake an already pending producer read.
      void cancelReader(signal.reason);
    };
    port1.on("message", () => wake());
    port1.on("close", abort);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      let current: Uint8Array | undefined;
      let offset = 0;
      while (true) {
        if (!available) await new Promise<void>((resolve) => { credit = resolve; });
        available = false;
        signal.throwIfAborted();
        if (cancelled) throw new Error("Function body consumer cancelled");
        if (!current || offset === current.byteLength) {
          current = small.shift();
          if (!current && pending.byteLength) { current = pending; pending = new Uint8Array(0); }
          if (!current) {
            let next = await read();
            while (!next.done && next.value.byteLength === 0) next = await read();
            if (next.done) { port1.postMessage({ done: true }); break; }
            current = next.value;
          }
          offset = 0;
        }
        // Always copy: user streams may reuse Buffer slabs or their backing ArrayBuffer.
        const owned = new Uint8Array(current.subarray(offset, offset + BODY_CHUNK_BYTES));
        offset += owned.byteLength;
        port1.postMessage({ chunk: owned.buffer }, [owned.buffer]);
      }
    } catch (error) {
      port1.postMessage({ done: true,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 4096),
        limit: error instanceof BodyLimitError ? error.limit : undefined,
      });
      await cancelReader(error);
    } finally {
      if (cancellation) await cancellation;
      small = []; pending = new Uint8Array(0);
      signal.removeEventListener("abort", abort);
      port1.removeAllListeners(); port1.close();
      closeReader();
    }
  };
  return { port: port2, run };
}
