/**
 * Zero-dependency, lightweight reactive signals modeled after Angular Signals and TC39 Signals.
 * Provides fine-grained reactive state without RxJS or runtime reflection.
 */

export interface Signal<T> {
  (): T;
}

export interface WritableSignal<T> extends Signal<T> {
  set(value: T): void;
  update(updateFn: (current: T) => T): void;
  asReadonly(): Signal<T>;
}

type Consumer = () => void;

let activeConsumer: Consumer | null = null;
let isTrackingEnabled = true;

/**
 * Creates a writable signal with initial value.
 */
export function signal<T>(initialValue: T): WritableSignal<T> {
  let value = initialValue;
  const subscribers = new Set<Consumer>();

  const read = (() => {
    if (isTrackingEnabled && activeConsumer) {
      subscribers.add(activeConsumer);
    }
    return value;
  }) as WritableSignal<T>;

  read.set = (newValue: T) => {
    if (!Object.is(value, newValue)) {
      value = newValue;
      for (const notify of [...subscribers]) {
        notify();
      }
    }
  };

  read.update = (updateFn: (current: T) => T) => {
    read.set(updateFn(value));
  };

  read.asReadonly = () => (() => read()) as Signal<T>;

  return read;
}

/**
 * Creates a computed, read-only signal derived from other signals.
 * Evaluates lazily and caches the result until dependencies change.
 */
export function computed<T>(computation: () => T): Signal<T> {
  let cachedValue: T;
  let isDirty = true;
  const subscribers = new Set<Consumer>();

  const recompute = () => {
    if (!isDirty) {
      isDirty = true;
      for (const notify of [...subscribers]) {
        notify();
      }
    }
  };

  return (() => {
    if (isTrackingEnabled && activeConsumer) {
      subscribers.add(activeConsumer);
    }
    if (isDirty) {
      const prevConsumer = activeConsumer;
      activeConsumer = recompute;
      try {
        cachedValue = computation();
        isDirty = false;
      } finally {
        activeConsumer = prevConsumer;
      }
    }
    return cachedValue;
  }) as Signal<T>;
}

/**
 * Creates a reactive effect that runs computation immediately and re-runs whenever any read signal changes.
 * Returns a teardown function.
 */
export function effect(effectFn: () => void | (() => void)): () => void {
  let cleanup: void | (() => void);
  let isDestroyed = false;

  const run = () => {
    if (isDestroyed) return;
    if (typeof cleanup === "function") {
      cleanup();
    }
    const prevConsumer = activeConsumer;
    activeConsumer = run;
    try {
      cleanup = effectFn();
    } finally {
      activeConsumer = prevConsumer;
    }
  };

  run();

  return () => {
    isDestroyed = true;
    if (typeof cleanup === "function") {
      cleanup();
    }
  };
}

/**
 * Runs a function without registering signal dependencies.
 */
export function untracked<T>(fn: () => T): T {
  const prevTracking = isTrackingEnabled;
  isTrackingEnabled = false;
  try {
    return fn();
  } finally {
    isTrackingEnabled = prevTracking;
  }
}
