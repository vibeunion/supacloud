/** Provider-oriented HTTP entry. Does not load the package root. */
export {
  HttpClient, HttpErrorResponse, provideHttpClient, withFetch, withRequestsMadeViaParent,
} from "./http_client";
export { HttpContext, HttpContextToken } from "./http_context";
export { HttpHeaders } from "./http_headers";
export { HttpParams } from "./http_params";
export {
  createBearerAuthInterceptor, createHeaderInterceptor, createRetryInterceptor, createTimeoutInterceptor,
} from "./interceptor";
export type { HttpClientConfig, HttpClientFeature, HttpRequestOptions } from "./http_client";
export type { HttpInterceptorFn } from "./interceptor";
import { HTTP_INTERCEPTORS } from "./http_client";
import type { HttpClientFeature } from "./http_client";
import type { HttpInterceptorFn } from "./interceptor";

/** Compose an HTTP provider feature; the interceptor module's withInterceptors remains the array helper. */
export function withInterceptors(...interceptors: (HttpInterceptorFn | HttpInterceptorFn[])[]): HttpClientFeature {
  return { kind: "Interceptors", providers: [{ provide: HTTP_INTERCEPTORS, useValue: interceptors.flat(), multi: true }] };
}
