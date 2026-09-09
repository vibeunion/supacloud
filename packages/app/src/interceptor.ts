import type { HttpContext } from "./http_context";
import { allowsHttpReplay, replayHeaders, validateReplayPolicy, type HttpReplayPolicy } from "./http_replay";

/**
 * Angular-inspired functional HTTP interceptor pipeline.
 * Modeled after Angular 15+ HttpInterceptorFn and withInterceptors API.
 */

export interface HttpRequestPayload {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  context?: HttpContext;
  replay?: HttpReplayPolicy;
  signal?: AbortSignal;
}

export type HttpInterceptorFn = (
  req: HttpRequestPayload,
  next: (req: HttpRequestPayload) => Promise<Response>,
) => Promise<Response>;

/**
 * Chains multiple functional interceptors into a single interceptor pipeline.
 */
export function withInterceptors(...interceptors: HttpInterceptorFn[]): HttpInterceptorFn[] {
  return interceptors.flat();
}

/**
 * Creates an interceptor that appends an Authorization: Bearer <token> header.
 */
export function createBearerAuthInterceptor(
  tokenOrGetter: string | (() => string | Promise<string>),
): HttpInterceptorFn {
  return async (req, next) => {
    const token = typeof tokenOrGetter === "function" ? await tokenOrGetter() : tokenOrGetter;
    if (token) {
      req.headers = {
        ...req.headers,
        authorization: `Bearer ${token}`,
      };
    }
    return next(req);
  };
}

/**
 * Creates an interceptor that merges static or dynamic headers.
 */
export function createHeaderInterceptor(
  headers: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>),
): HttpInterceptorFn {
  return async (req, next) => {
    const custom = typeof headers === "function" ? await headers() : headers;
    req.headers = {
      ...req.headers,
      ...custom,
    };
    return next(req);
  };
}

/**
 * Creates an interceptor that aborts the request after timeoutMs.
 */
export function createTimeoutInterceptor(timeoutMs: number): HttpInterceptorFn {
  return async (req, next) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<Response>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`HTTP request timed out after ${timeoutMs}ms: ${req.method} ${req.url}`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([next(req), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/**
 * Retries transient read failures. Writes require an explicit idempotency contract.
 * Authentication/authorization failures and cancelled requests are never retried.
 */
export function createRetryInterceptor(maxRetries: number, delayMs = 50): HttpInterceptorFn {
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0
    || !Number.isFinite(delayMs) || delayMs < 0 || delayMs > 2_147_483_647) {
    throw new RangeError("Invalid HTTP retry limits");
  }
  return async (req, next) => {
    const replay = validateReplayPolicy(req.replay);
    const allowed = allowsHttpReplay(req.method, replay);
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      req.signal?.throwIfAborted();
      req.headers = replayHeaders(req.headers, replay);
      try {
        const res = await next(req);
        if (!allowed || attempt === maxRetries || ![408, 429, 500, 502, 503, 504].includes(res.status)) return res;
        // Custom stream cancellation must not block backoff or signal handling.
        void res.body?.cancel().catch(() => undefined);
      } catch (err) {
        if (!allowed || attempt === maxRetries || req.signal?.aborted
          || (err instanceof Error && (err.name === "AbortError" || err.name === "HttpReplayError"))) throw err;
      }
      if (delayMs > 0) {
        await retryDelay(delayMs, req.signal);
      }
    }
    throw new Error("HTTP retry budget exhausted");
  };
}

function retryDelay(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("HTTP request aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
