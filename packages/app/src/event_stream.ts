import { Observable, Subject, Subscription } from "rxjs";

export type EventOverflowStrategy = "error" | "drop-oldest" | "drop-newest";

export class EventStreamClosedError extends Error {
  readonly code = "EVENT_STREAM_CLOSED" as const;

  constructor() {
    super("Event stream is closed");
    this.name = "EventStreamClosedError";
  }
}

export class EventStreamOverflowError extends Error {
  readonly code = "EVENT_STREAM_OVERFLOW" as const;

  constructor(readonly maxQueue: number) {
    super(`Event stream consumer queue exceeded its limit of ${maxQueue}`);
    this.name = "EventStreamOverflowError";
  }
}

export interface ApplicationEventStreamOptions {
  /** Maximum number of events buffered per governed subscription. */
  maxQueue?: number;
  /** Default overflow policy. `error` is fail-closed and is the safe default. */
  overflow?: EventOverflowStrategy;
}

export interface EventSubscriptionOptions<T> {
  signal?: AbortSignal;
  maxQueue?: number;
  overflow?: EventOverflowStrategy;
  /** Consumer failures are isolated from the stream and reported here. */
  onError?: (error: unknown, event?: T) => void | Promise<void>;
}

export interface EventSubscription {
  readonly closed: boolean;
  readonly completion: Promise<void>;
  unsubscribe(): void;
}

export interface ApplicationEventStream<T> {
  /** Raw RxJS view for composition. Use subscribe() for governed consumers. */
  readonly observable: Observable<T>;
  publish(value: T): Promise<void>;
  subscribe(
    handler: (value: T) => void | Promise<void>,
    options?: EventSubscriptionOptions<T>,
  ): EventSubscription;
  close(): Promise<void>;
}

interface Consumer<T> {
  closed: boolean;
  queue: T[];
  maxQueue: number;
  overflow: EventOverflowStrategy;
  handler: (value: T) => void | Promise<void>;
  onError?: (error: unknown, event?: T) => void | Promise<void>;
  source: Subscription;
  running: Promise<void> | undefined;
  resolveCompletion: () => void;
  completion: Promise<void>;
  abort?: () => void;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("Event stream queue limits must be positive safe integers");
  }
  return value;
}

/**
 * Creates a framework-neutral event stream boundary.
 *
 * RxJS is deliberately contained here: HTTP handlers, command executors and
 * transaction callbacks continue to use their existing Promise contracts.
 * `subscribe` serializes asynchronous consumers and applies a bounded queue;
 * `observable` is available for read-only RxJS composition when a consumer
 * explicitly accepts its unbounded semantics.
 */
export function createApplicationEventStream<T>(
  options: ApplicationEventStreamOptions = {},
): ApplicationEventStream<T> {
  const defaultMaxQueue = positiveInteger(options.maxQueue, 256);
  const defaultOverflow = options.overflow ?? "error";
  const subject = new Subject<T>();
  const consumers = new Set<Consumer<T>>();
  let closed = false;
  const publishErrorStack: EventStreamOverflowError[][] = [];

  const finishConsumer = (consumer: Consumer<T>): void => {
    if (!consumer.closed || consumer.running) return;
    consumer.queue.length = 0;
    consumer.resolveCompletion();
  };

  const report = (consumer: Consumer<T>, error: unknown, event?: T): void => {
    if (!consumer.onError) return;
    void Promise.resolve(consumer.onError(error, event)).catch(() => undefined);
  };

  const pump = async (consumer: Consumer<T>): Promise<void> => {
    while (!consumer.closed && consumer.queue.length > 0) {
      const value = consumer.queue.shift() as T;
      try {
        await consumer.handler(value);
      } catch (error) {
        report(consumer, error, value);
      }
    }
  };

  const stop = (consumer: Consumer<T>): void => {
    if (consumer.closed) return;
    consumer.closed = true;
    consumer.queue.length = 0;
    consumer.source.unsubscribe();
    if (consumer.abort) consumer.abort();
    consumers.delete(consumer);
    finishConsumer(consumer);
  };

  const enqueue = (consumer: Consumer<T>, value: T): void => {
    if (consumer.closed) return;
    if (consumer.queue.length >= consumer.maxQueue) {
      if (consumer.overflow === "drop-newest") return;
      if (consumer.overflow === "drop-oldest") {
        consumer.queue.shift();
      } else {
        const error = new EventStreamOverflowError(consumer.maxQueue);
        publishErrorStack.at(-1)?.push(error);
        report(consumer, error, value);
        stop(consumer);
        return;
      }
    }
    consumer.queue.push(value);
    if (!consumer.running) {
      consumer.running = pump(consumer).finally(() => {
        consumer.running = undefined;
        finishConsumer(consumer);
      });
    }
  };

  const subscribe = (
    handler: (value: T) => void | Promise<void>,
    subscriptionOptions: EventSubscriptionOptions<T> = {},
  ): EventSubscription => {
    if (typeof handler !== "function") throw new TypeError("Event stream handler must be callable");
    const maxQueue = positiveInteger(subscriptionOptions.maxQueue, defaultMaxQueue);
    const overflow = subscriptionOptions.overflow ?? defaultOverflow;
    let resolveCompletion!: () => void;
    const completion = new Promise<void>(resolve => { resolveCompletion = resolve; });
    const consumer = {} as Consumer<T>;
    consumer.closed = closed || subscriptionOptions.signal?.aborted === true;
    consumer.queue = [];
    consumer.maxQueue = maxQueue;
    consumer.overflow = overflow;
    consumer.handler = handler;
    consumer.onError = subscriptionOptions.onError;
    consumer.resolveCompletion = resolveCompletion;
    consumer.completion = completion;
    consumer.source = subject.subscribe(value => enqueue(consumer, value));
    consumers.add(consumer);
    if (subscriptionOptions.signal) {
      const onAbort = () => stop(consumer);
      consumer.abort = () => subscriptionOptions.signal?.removeEventListener("abort", onAbort);
      if (!consumer.closed) subscriptionOptions.signal.addEventListener("abort", onAbort, { once: true });
      else consumer.source.unsubscribe();
    }
    if (consumer.closed) finishConsumer(consumer);
    return {
      get closed() { return consumer.closed; },
      completion,
      unsubscribe: () => stop(consumer),
    };
  };

  return {
    observable: subject.asObservable(),
    publish(value: T): Promise<void> {
      if (closed) return Promise.reject(new EventStreamClosedError());
      const errors: EventStreamOverflowError[] = [];
      publishErrorStack.push(errors);
      subject.next(value);
      publishErrorStack.pop();
      if (errors.length === 1) return Promise.reject(errors[0]);
      if (errors.length > 1) return Promise.reject(new AggregateError(errors, "Event stream publish failed"));
      return Promise.resolve();
    },
    subscribe,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      subject.complete();
      const active = [...consumers];
      for (const consumer of active) stop(consumer);
      await Promise.all(active.map(consumer => consumer.completion));
      consumers.clear();
    },
  };
}
