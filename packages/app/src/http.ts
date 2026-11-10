/**
 * Angular-free HTTP helpers: headers, params, context, interceptor functions,
 * and provider feature objects. This entry does not import `@angular/core`.
 *
 * The inject-based `HttpClient` and `provideHttpClient` are
 * `@supacloud/app/runtime` only.
 */
export { HttpErrorResponse } from "./http_client_core";
export type { HttpClientConfig, HttpRequestOptions } from "./http_client_core";
export {
  HTTP_CLIENT_CONFIG,
  HTTP_INTERCEPTORS,
  withFetch,
  withInterceptors,
  withRequestsMadeViaParent,
} from "./http_features";
export type { HttpClientFeature, HttpClientFeatureKind } from "./http_features";
export { HttpContext, HttpContextToken } from "./http_context";
export { HttpHeaders } from "./http_headers";
export { HttpParams } from "./http_params";
export {
  createBearerAuthInterceptor,
  createHeaderInterceptor,
  createRetryInterceptor,
  createTimeoutInterceptor,
} from "./interceptor";
export type { HttpInterceptorFn } from "./interceptor";
