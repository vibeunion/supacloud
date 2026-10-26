import type { MessagePort } from "node:worker_threads";
import { BODY_CHUNK_BYTES, BodyLimitError, type BodyBufferBudget, type BodyBufferLease } from "./body-transfer";

type BodyMessage = { chunk: ArrayBuffer } | { done: true; error?: string; limit?: number };

/** Bounded read-ahead decouples completed tenant execution from slow delivery. */
export function receiveBufferedResponse(options: {
  port: MessagePort;
  lease: BodyBufferLease;
  bodyBudget: BodyBufferBudget;
  responseBudget: BodyBufferBudget;
  readAheadBytes: number;
  signal: AbortSignal;
  idleTimeoutMs: number;
  onCancel: (error?: Error) => void;
  onProducerDone: () => void;
  onConsumerDone: () => void;
}) {
  const { port, lease, responseBudget } = options;
  const responseLease = responseBudget.lease();
  let chunks: Array<Uint8Array | undefined> = [];
  let head = 0;
  let bytes = 0;
  let credit = false;
  let producerDone = false;
  let closed = false;
  let pulling: (() => void) | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let unsubscribeBody = () => {};
  let unsubscribeResponse = () => {};
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resize = () => {
    // Shrinks only: the outstanding credit was reserved before posting.
    lease.resize(bytes + (credit ? BODY_CHUNK_BYTES : 0));
    responseLease.resize(bytes + (credit ? BODY_CHUNK_BYTES : 0));
  };
  const detachProducer = () => {
    port.removeAllListeners(); port.close();
    unsubscribeBody(); unsubscribeResponse();
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    detachProducer();
    options.signal.removeEventListener("abort", abort);
    clearTimeout(idleTimer);
    chunks = []; head = 0; bytes = 0;
    lease.release(); responseLease.release();
    pulling?.(); pulling = undefined;
    options.onConsumerDone();
  };
  const fail = (error: Error) => {
    if (closed) return;
    controller.error(error);
    finish();
  };
  const abort = () => {
    const error = new Error("Function body cancelled");
    fail(error); options.onCancel(error);
  };
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const error = new Error("Function response delivery timed out");
      fail(error); options.onCancel(error);
    }, options.idleTimeoutMs);
    idleTimer.unref?.();
  };
  const pump = () => {
    if (closed || producerDone || credit) return;
    // readAhead=0 retains strict demand-driven behavior for constrained hosts.
    if (!pulling && (bytes + BODY_CHUNK_BYTES > options.readAheadBytes || chunks.length - head >= 256)) return;
    const next = bytes + BODY_CHUNK_BYTES;
    // Check both synchronously before mutating either reservation. Rolling one
    // back would itself notify subscribers and create a busy retry loop.
    if (!responseLease.canResize(next) || !lease.canResize(next)) return;
    responseLease.resize(next);
    lease.resize(next);
    credit = true;
    try { port.postMessage("pull"); }
    catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error));
      fail(reason); options.onCancel(reason);
    }
  };
  const flush = () => {
    if (closed || !pulling) return;
    const chunk = chunks[head];
    if (chunk) {
      // Clear consumed references without repeated array shifting/copying.
      chunks[head++] = undefined;
      if (head === chunks.length) { chunks = []; head = 0; }
      else if (head >= 128) { chunks = chunks.slice(head); head = 0; }
      bytes -= chunk.byteLength;
      controller.enqueue(chunk);
      resize();
      const resolve = pulling; pulling = undefined; resolve();
    } else if (producerDone) {
      controller.close(); finish();
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(target) {
      controller = target;
      port.on("message", (message: BodyMessage) => {
        if (closed) return;
        credit = false;
        if ("done" in message) {
          if (message.error) {
            const error = message.limit === undefined ? new Error(message.error) : new BodyLimitError(message.limit);
            fail(error); options.onCancel(error); return;
          }
          producerDone = true;
          resize(); detachProducer(); flush();
          options.onProducerDone();
        } else {
          const chunk = new Uint8Array(message.chunk);
          chunks.push(chunk); bytes += chunk.byteLength;
          resize(); flush(); pump();
        }
      });
      port.on("close", () => {
        if (closed || producerDone) return;
        const error = new Error("Function body transport closed");
        fail(error); options.onCancel(error);
      });
      unsubscribeBody = options.bodyBudget.onAvailable(pump);
      unsubscribeResponse = responseBudget.onAvailable(pump);
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();
      else { resetIdleTimer(); pump(); }
    },
    pull() {
      if (closed) return;
      resetIdleTimer();
      return new Promise<void>((resolve) => { pulling = resolve; flush(); pump(); });
    },
    cancel() { if (!closed) { finish(); options.onCancel(); } },
  }, { highWaterMark: 0 });
  return { stream, fail };
}
