import { signal, effect, untracked, type Signal, type WritableSignal } from "./signal";

export type ResourceStatus = "idle" | "loading" | "resolved" | "error";

export interface ResourceLoaderParams<R> {
  request: R;
  abortSignal: AbortSignal;
  previous?: {
    status: ResourceStatus;
  };
}

export interface ResourceOptions<T, R = unknown> {
  /** Reactive request getter. Re-executes loader whenever signals read inside change. */
  request?: () => R;
  /** Asynchronous loader that fetches data for the request. */
  loader: (params: ResourceLoaderParams<R>) => Promise<T>;
  /** Optional initial value before first load resolves. */
  initialValue?: T;
}

export interface ResourceRef<T> {
  /** The current loaded value, or undefined if not yet resolved. */
  readonly value: Signal<T | undefined>;
  /** The current lifecycle status: 'idle' | 'loading' | 'resolved' | 'error'. */
  readonly status: Signal<ResourceStatus>;
  /** The error encountered during the last load, if any. */
  readonly error: Signal<unknown | undefined>;
  /** Boolean indicating whether a load is currently in progress. */
  readonly isLoading: Signal<boolean>;
  /** Triggers a reload using the current request. */
  reload(): void;
  /** Sets the value directly, transitioning status to 'resolved'. */
  set(value: T): void;
  /** Updates the value directly using a transformation function. */
  update(updateFn: (current: T | undefined) => T): void;
  /** Destroys the resource, aborting any active requests and disposing internal effects. */
  destroy(): void;
}

/**
 * Creates an asynchronous resource driven by reactive signals.
 * Modeled directly after Angular 19's resource() API.
 */
export function resource<T, R = unknown>(options: ResourceOptions<T, R>): ResourceRef<T> {
  const valueSignal: WritableSignal<T | undefined> = signal<T | undefined>(options.initialValue);
  const statusSignal: WritableSignal<ResourceStatus> = signal<ResourceStatus>("idle");
  const errorSignal: WritableSignal<unknown | undefined> = signal<unknown | undefined>(undefined);
  const isLoadingSignal: WritableSignal<boolean> = signal<boolean>(false);

  let activeAbortController: AbortController | null = null;
  const reloadCounter = signal(0);
  let isDestroyed = false;

  const load = async (req: R) => {
    if (isDestroyed) return;

    if (activeAbortController) {
      activeAbortController.abort();
    }
    const ac = new AbortController();
    activeAbortController = ac;

    const prevStatus = statusSignal();
    statusSignal.set("loading");
    isLoadingSignal.set(true);
    errorSignal.set(undefined);

    try {
      const result = await options.loader({
        request: req,
        abortSignal: ac.signal,
        previous: { status: prevStatus },
      });

      if (!ac.signal.aborted && !isDestroyed) {
        valueSignal.set(result);
        statusSignal.set("resolved");
        isLoadingSignal.set(false);
      }
    } catch (err) {
      if (!ac.signal.aborted && !isDestroyed) {
        errorSignal.set(err);
        statusSignal.set("error");
        isLoadingSignal.set(false);
      }
    } finally {
      if (activeAbortController === ac) {
        activeAbortController = null;
      }
    }
  };

  const disposeEffect = effect(() => {
    reloadCounter(); // track reload triggers
    const req = options.request ? options.request() : (undefined as unknown as R);
    untracked(() => {
      load(req);
    });
  });

  return {
    value: valueSignal.asReadonly(),
    status: statusSignal.asReadonly(),
    error: errorSignal.asReadonly(),
    isLoading: isLoadingSignal.asReadonly(),
    reload() {
      reloadCounter.update((c) => c + 1);
    },
    set(newVal: T) {
      if (activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;
      }
      valueSignal.set(newVal);
      statusSignal.set("resolved");
      errorSignal.set(undefined);
      isLoadingSignal.set(false);
    },
    update(updateFn: (current: T | undefined) => T) {
      this.set(updateFn(valueSignal()));
    },
    destroy() {
      isDestroyed = true;
      if (activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;
      }
      disposeEffect();
    },
  };
}
