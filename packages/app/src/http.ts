/** Provider-oriented HTTP entry. Reuse root identities rather than bundle another injector/client. */
export {
  HttpClient, HttpErrorResponse, HttpContext, HttpContextToken, HttpHeaders, HttpParams,
  provideHttpClient, withFetch, withRequestsMadeViaParent,
  createBearerAuthInterceptor, createHeaderInterceptor, createRetryInterceptor, createTimeoutInterceptor,
} from "@supacloud/app";
export type { HttpClientConfig, HttpClientFeature, HttpRequestOptions, HttpInterceptorFn } from "@supacloud/app";
import { HTTP_INTERCEPTORS, type HttpClientFeature, type HttpInterceptorFn } from "@supacloud/app";

/** Compose an HTTP provider feature; root withInterceptors remains the legacy array helper. */
export function withInterceptors(...interceptors: (HttpInterceptorFn | HttpInterceptorFn[])[]): HttpClientFeature {
  return { kind: "Interceptors", providers: [{ provide: HTTP_INTERCEPTORS, useValue: interceptors.flat(), multi: true }] };
}
