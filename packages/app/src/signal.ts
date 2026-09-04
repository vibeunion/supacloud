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

export interface LinkedSignalOptions<S, D> {
  source: () => S;
  computation: (source: S, previous?: { source: S; value: D }) => D;
  equal?: (a: D, b: D) => boolean;
}

/**
 * Creates a writable signal whose value is linked to a source reactive computation.
 * When the source dependencies change, the linkedSignal automatically recomputes its value.
 * Unlike a standard computed signal, a linkedSignal is writable and can be manually modified.
 * Modeled directly after Angular 19's linkedSignal.
 */
export function linkedSignal<D>(
  computation: () => D,
  options?: { equal?: (a: D, b: D) => boolean },
): WritableSignal<D>;
export function linkedSignal<S, D = S>(
  options: LinkedSignalOptions<S, D>,
): WritableSignal<D>;
export function linkedSignal<S, D>(
  computationOrOptions: (() => D) | LinkedSignalOptions<S, D>,
  shorthandOptions?: { equal?: (a: D, b: D) => boolean },
): WritableSignal<D> {
  let sourceFn: () => S;
  let computationFn: (source: S, previous?: { source: S; value: D }) => D;
  let equalFn: (a: D, b: D) => boolean;

  if (typeof computationOrOptions === "function") {
    sourceFn = computationOrOptions as unknown as () => S;
    computationFn = (s: S) => s as unknown as D;
    equalFn = shorthandOptions?.equal ?? Object.is;
  } else {
    sourceFn = computationOrOptions.source;
    computationFn = computationOrOptions.computation;
    equalFn = computationOrOptions.equal ?? Object.is;
  }

  let currentValue: D;
  let hasValue = false;
  let previousRecord: { source: S; value: D } | undefined = undefined;
  let isDirty = true;
  const subscribers = new Set<Consumer>();

  const onSourceChanged = () => {
    if (!isDirty) {
      isDirty = true;
      for (const notify of [...subscribers]) {
        notify();
      }
    }
  };

  const recompute = () => {
    const prevConsumer = activeConsumer;
    activeConsumer = onSourceChanged;
    let nextSource: S;
    try {
      nextSource = sourceFn();
    } finally {
      activeConsumer = prevConsumer;
    }

    if (hasValue && previousRecord && Object.is(nextSource, previousRecord.source)) {
      isDirty = false;
      return currentValue;
    }

    const nextValue = computationFn(nextSource, previousRecord);
    currentValue = nextValue;
    hasValue = true;
    previousRecord = { source: nextSource, value: currentValue };
    isDirty = false;
    return currentValue;
  };

  const read = (() => {
    if (isTrackingEnabled && activeConsumer) {
      subscribers.add(activeConsumer);
    }
    if (isDirty || !hasValue) {
      return recompute();
    }
    return currentValue;
  }) as WritableSignal<D>;

  read.set = (newValue: D) => {
    if (!hasValue || isDirty) {
      recompute();
    }
    if (!equalFn(currentValue, newValue)) {
      currentValue = newValue;
      if (previousRecord) {
        previousRecord.value = newValue;
      }
      for (const notify of [...subscribers]) {
        notify();
      }
    }
  };

  read.update = (updateFn: (current: D) => D) => {
    read.set(updateFn(read()));
  };

  read.asReadonly = () => (() => read()) as Signal<D>;

  return read;
}
