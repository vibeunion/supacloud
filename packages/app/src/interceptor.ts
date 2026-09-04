/**
 * Angular-inspired functional HTTP interceptor pipeline.
 * Modeled after Angular 15+ HttpInterceptorFn and withInterceptors API.
 */

export interface HttpRequestPayload {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
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
 * Creates an interceptor that retries on failed requests up to maxRetries.
 */
export function createRetryInterceptor(maxRetries: number, delayMs = 50): HttpInterceptorFn {
  return async (req, next) => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await next(req);
        if (res.ok || attempt === maxRetries) return res;
      } catch (err) {
        lastError = err;
        if (attempt === maxRetries) throw err;
      }
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  };
}
