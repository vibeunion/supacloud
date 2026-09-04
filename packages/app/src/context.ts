import { InjectionToken } from "./token";

/**
 * Built-in token resolved from the request-context argument of a compiled
 * `createRequestScope(services, ctx)` factory. Request-scoped providers that
 * declare this token as a dependency receive the raw request context.
 */
export const REQUEST_CONTEXT = new InjectionToken<unknown>("supacloud.request-context", {
  scope: "request",
});

/**
 * Built-in token resolved from the job-context argument of a compiled
 * `createJobScope(services, ctx)` factory. Job-scoped providers that declare
 * this token as a dependency receive the raw job context (task id, lease,
 * cancellation signal, ...).
 */
export const JOB_CONTEXT = new InjectionToken<unknown>("supacloud.job-context", {
  scope: "job",
});

/**
 * Built-in token for the platform database client (PostgreSQL/Drizzle client)
 * passed to `createApplication({ deps: { dbClient } })`.
 */
export const DB_CLIENT = new InjectionToken<unknown>("supacloud.db-client", {
  scope: "application",
});

/**
 * Built-in multi-provider token for application startup lifecycle hooks.
 * Modeled after Angular's APP_INITIALIZER.
 * Initializer providers can return void or a Promise<void>; the application startup sequence
 * executes all registered initializers before accepting traffic.
 */
export const APP_INITIALIZER = new InjectionToken<() => void | Promise<void>>(
  "supacloud.app-initializer",
  { scope: "application" },
);

/**
 * Lifecycle interface for services that need to perform teardown logic when the application shuts down.
 * Modeled after Angular's OnDestroy.
 */
export interface OnDestroy {
  onDestroy(): void | Promise<void>;
}

/**
 * Mechanism to register teardown callbacks for an active context or service.
 * Modeled directly after Angular's DestroyRef.
 */
export interface DestroyRef {
  onDestroy(callback: () => void | Promise<void>): () => void;
}

/**
 * Built-in token for registering teardown callbacks.
 * Modeled after Angular's DestroyRef.
 */
export const DESTROY_REF = new InjectionToken<DestroyRef>("supacloud.destroy-ref", {
  scope: "application",
  factory: () => createDestroyRef(),
});

/**
 * Creates a default DestroyRef instance for tracking teardown hooks.
 */
export function createDestroyRef(): DestroyRef & {
  readonly destroyed: boolean;
  destroy(): Promise<void>;
  _teardowns: Array<() => void | Promise<void>>;
} {
  let isDestroyed = false;
  const callbacks: Array<() => void | Promise<void>> = [];

  return {
    get destroyed() {
      return isDestroyed;
    },
    onDestroy(callback: () => void | Promise<void>): () => void {
      if (isDestroyed) {
        throw new Error("Cannot register onDestroy callback on an already destroyed DestroyRef");
      }
      callbacks.push(callback);
      return () => {
        const idx = callbacks.indexOf(callback);
        if (idx !== -1) callbacks.splice(idx, 1);
      };
    },
    async destroy(): Promise<void> {
      if (isDestroyed) return;
      isDestroyed = true;
      const reversed = [...callbacks].reverse();
      callbacks.length = 0;
      for (const cb of reversed) {
        await cb();
      }
    },
    _teardowns: callbacks,
  };
}
