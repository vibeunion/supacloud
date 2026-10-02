/** Browser/server reactive integration. The normal app/execution entries stay unchanged. */
import { Observable, Subscriber, type MonoTypeOperatorFunction } from "rxjs";

/** Complete on owner cancellation; an already-aborted owner never starts the source. */
export function takeUntilAborted<T>(signal: AbortSignal): MonoTypeOperatorFunction<T> {
  return source => new Observable<T>(subscriber => {
    const stop = () => subscriber.complete();
    subscriber.add(() => signal.removeEventListener("abort", stop));
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) {
      subscriber.complete();
      return;
    }
    source.subscribe(subscriber);
  });
}

export class ReactiveBufferOverflowError extends Error {
  readonly code = "REACTIVE_BUFFER_OVERFLOW";
  constructor(readonly capacity: number) {
    super(`Reactive stream exceeded its ${capacity}-item buffer`);
    this.name = "ReactiveBufferOverflowError";
  }
}

export interface ReactiveStreamOptions {
  /** Bind to the request/connection/worker owner, not a process-global user context. */
  signal?: AbortSignal;
  /** Maximum queued items, not bytes. Overflow fails closed instead of dropping events. */
  capacity?: number;
}

/**
 * A bounded transport bridge, NOT durable delivery or acknowledgement.
 * Creating the stream subscribes immediately. cancel/abort/error releases the subscription.
 * Sources producing synchronously must observe subscriber.closed after overflow.
 */
export function toReadableStream<T>(
  source: Observable<T>,
  options: ReactiveStreamOptions = {},
): ReadableStream<T> {
  const capacity = options.capacity ?? 16;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 65536) {
    throw new RangeError("Reactive stream capacity must be an integer between 1 and 65536");
  }
  const signal = options.signal;
  let subscription: Subscriber<T> | undefined;
  let stopped = false;
  let removeAbort = () => {};
  const release = () => {
    stopped = true;
    removeAbort();
    subscription?.unsubscribe();
  };
  return new ReadableStream<T>({
    start(controller) {
      const fail = (error: unknown) => {
        if (stopped) return;
        // Stop production before notifying the consumer, including synchronous sources.
        try { release(); }
        catch (cleanupError) {
          controller.error(new AggregateError([error, cleanupError], "Reactive stream cleanup failed"));
          return;
        }
        controller.error(error);
      };
      const abort = () => fail(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      removeAbort = () => signal?.removeEventListener("abort", abort);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      subscription = new Subscriber<T>({
        next(value) {
          if (stopped) return;
          if ((controller.desiredSize ?? 0) <= 0) {
            fail(new ReactiveBufferOverflowError(capacity));
            return;
          }
          controller.enqueue(value);
        },
        error: fail,
        complete() {
          if (stopped) return;
          try { release(); }
          catch (error) { controller.error(error); return; }
          controller.close();
        },
      });
      source.subscribe(subscription);
    },
    cancel() { release(); },
  }, { highWaterMark: capacity, size: () => 1 });
}
