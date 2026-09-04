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
