/**
 * Browser-safe application HTTP entrypoint.
 *
 * The root entrypoint includes Bun/Node DI integration. Import this entrypoint
 * from browser applications so bundlers never traverse the server runtime.
 */
import {
  HttpClientCore,
  HttpErrorResponse,
  type HttpClientConfig,
  type HttpRequestOptions,
} from "./http_client_core";

export class HttpClient extends HttpClientCore {}
export { HttpErrorResponse, type HttpClientConfig, type HttpRequestOptions };
export { HttpContext, HttpContextToken } from "./http_context";
export { HttpHeaders } from "./http_headers";
export { HttpParams } from "./http_params";
export {
  createBearerAuthInterceptor,
  createHeaderInterceptor,
  createRetryInterceptor,
  withInterceptors,
  type HttpInterceptorFn,
  type HttpRequestPayload,
} from "./interceptor";
export { HttpContractError, type HttpContract } from "./http_contract";
export {
  HttpReplayError,
  type HttpReplayPolicy,
} from "./http_replay";
