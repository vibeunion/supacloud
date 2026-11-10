/**
 * Angular injector adapter. Importing this module loads `@angular/core`.
 * `@supacloud/app` and `@supacloud/app/core` do not.
 *
 * Browser signal/RxJS adapters stay on `@supacloud/app/angular` and
 * `@supacloud/app/rxjs` so they do not load `node:async_hooks`.
 * Pending work stays on `@supacloud/app/pending-work`.
 */
export {
  INJECTOR,
  assertInInjectionContext,
  createChildInjector,
  createEnvironmentInjector,
  getActiveInjector,
  inject,
  injectAll,
  injectDestroySignal,
  runInInjectionContext,
} from "./inject";
export type {
  EnvironmentInjector,
  EnvironmentInjectorOptions,
  InjectFlags,
  InjectorLike,
} from "./inject";
export {
  bootstrapBun,
  runInRequestContext,
  runInScope,
  runInTransactionContext,
} from "./bun";
export type { BunApplication, BunBootstrapOptions, BunServerLike } from "./bun";
export { TestBed } from "./testing";
export type { TestModuleMetadata } from "./testing";
export {
  HTTP_CLIENT_CONFIG,
  HTTP_INTERCEPTORS,
  HttpClient,
  HttpErrorResponse,
  provideHttpClient,
  withFetch,
  withRequestsMadeViaParent,
} from "./http_client";
export type {
  HttpClientConfig,
  HttpClientFeature,
  HttpClientFeatureKind,
  HttpRequestOptions,
} from "./http_client";
