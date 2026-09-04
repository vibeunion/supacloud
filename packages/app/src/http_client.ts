import { Injectable } from "./decorators";
import { HttpContext } from "./http_context";
import { HttpHeaders } from "./http_headers";
import { HttpParams } from "./http_params";
import { type HttpInterceptorFn, type HttpRequestPayload } from "./interceptor";
import { InjectionToken } from "./token";
import { inject, injectAll } from "./inject";
import { makeEnvironmentProviders, type EnvironmentProviders, type Provider } from "./provider";

export interface HttpClientConfig {
  baseUrl?: string;
  fetch?: typeof fetch;
}

export const HTTP_CLIENT_CONFIG = new InjectionToken<HttpClientConfig>(
  "HTTP_CLIENT_CONFIG",
  { scope: "application", factory: () => ({}) },
);

export const HTTP_INTERCEPTORS = new InjectionToken<HttpInterceptorFn[]>(
  "HTTP_INTERCEPTORS",
  { scope: "application", factory: () => [] },
);

export class HttpErrorResponse extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly url: string | null;
  readonly error: unknown;

  constructor(init: { error?: unknown; status?: number; statusText?: string; url?: string }) {
    super(`Http failure response for ${init.url ?? "unknown"}: ${init.status ?? 0} ${init.statusText ?? "Unknown Error"}`);
    this.name = "HttpErrorResponse";
    this.status = init.status ?? 0;
    this.statusText = init.statusText ?? "Unknown Error";
    this.url = init.url ?? null;
    this.error = init.error ?? null;
  }
}

export interface HttpRequestOptions {
  headers?: HttpHeaders | Record<string, string | string[]>;
  params?: HttpParams | Record<string, string | number | boolean | ReadonlyArray<string | number | boolean>>;
  body?: unknown;
  context?: HttpContext;
  observe?: "body" | "response";
  responseType?: "json" | "text" | "blob";
  signal?: AbortSignal;
}

export type HttpClientFeatureKind = "Fetch" | "Interceptors" | "ParentRequests";

export interface HttpClientFeature {
  kind: HttpClientFeatureKind;
  providers: Provider[];
}

export function withFetch(customFetch?: typeof fetch): HttpClientFeature {
  return {
    kind: "Fetch",
    providers: [
      {
        provide: HTTP_CLIENT_CONFIG,
        useFactory: () => ({ fetch: customFetch ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined) }),
      },
    ],
  };
}

export function withInterceptors(...interceptors: (HttpInterceptorFn | HttpInterceptorFn[])[]): HttpClientFeature {
  const flattened = interceptors.flat();
  return {
    kind: "Interceptors",
    providers: [
      {
        provide: HTTP_INTERCEPTORS,
        useValue: flattened,
        multi: true,
      },
    ],
  };
}

export function withRequestsMadeViaParent(): HttpClientFeature {
  return {
    kind: "ParentRequests",
    providers: [],
  };
}

export function provideHttpClient(...features: HttpClientFeature[]): EnvironmentProviders {
  const providers: Provider[] = [
    HttpClient,
  ];
  for (const feature of features) {
    providers.push(...feature.providers);
  }
  return makeEnvironmentProviders(providers);
}

@Injectable({ providedIn: "root" })
export class HttpClient {
  private config: HttpClientConfig;
  private interceptors: HttpInterceptorFn[];

  constructor(config?: HttpClientConfig, interceptors?: HttpInterceptorFn[]) {
    if (config) {
      this.config = config;
    } else {
      try {
        this.config = inject(HTTP_CLIENT_CONFIG, { optional: true }) ?? {};
      } catch {
        this.config = {};
      }
    }

    if (interceptors) {
      this.interceptors = [...interceptors];
    } else {
      try {
        const resolved = injectAll(HTTP_INTERCEPTORS);
        this.interceptors = resolved.flat();
      } catch {
        this.interceptors = [];
      }
    }
  }

  get<T = unknown>(url: string, options?: HttpRequestOptions): Promise<T> {
    return this.request<T>("GET", url, options);
  }

  post<T = unknown>(url: string, body?: unknown, options?: HttpRequestOptions): Promise<T> {
    return this.request<T>("POST", url, { ...options, body });
  }

  put<T = unknown>(url: string, body?: unknown, options?: HttpRequestOptions): Promise<T> {
    return this.request<T>("PUT", url, { ...options, body });
  }

  delete<T = unknown>(url: string, options?: HttpRequestOptions): Promise<T> {
    return this.request<T>("DELETE", url, options);
  }

  patch<T = unknown>(url: string, body?: unknown, options?: HttpRequestOptions): Promise<T> {
    return this.request<T>("PATCH", url, { ...options, body });
  }

  async request<T = unknown>(method: string, url: string, options?: HttpRequestOptions): Promise<T> {
    let targetUrl = url;
    if (this.config.baseUrl && !/^https?:\/\//i.test(targetUrl)) {
      const base = this.config.baseUrl.endsWith("/") ? this.config.baseUrl.slice(0, -1) : this.config.baseUrl;
      const rel = targetUrl.startsWith("/") ? targetUrl : `/${targetUrl}`;
      targetUrl = `${base}${rel}`;
    }

    if (options?.params) {
      const params = options.params instanceof HttpParams
        ? options.params
        : new HttpParams({ fromObject: options.params as Record<string, string | number | boolean> });
      const qs = params.toString();
      if (qs.length > 0) {
        targetUrl += targetUrl.includes("?") ? `&${qs}` : `?${qs}`;
      }
    }

    let headers: Record<string, string> = {};
    if (options?.headers) {
      if (options.headers instanceof HttpHeaders) {
        headers = options.headers.toObject();
      } else {
        for (const [k, v] of Object.entries(options.headers)) {
          if (v !== undefined && v !== null) {
            headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
          }
        }
      }
    }

    let body = options?.body;
    if (
      body !== undefined &&
      body !== null &&
      typeof body === "object" &&
      !(body instanceof FormData) &&
      !(body instanceof Blob) &&
      !(body instanceof URLSearchParams) &&
      !(body instanceof ArrayBuffer)
    ) {
      body = JSON.stringify(body);
      const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === "content-type");
      if (!hasContentType) {
        headers["content-type"] = "application/json";
      }
    }

    const payload: HttpRequestPayload = {
      method: method.toUpperCase(),
      url: targetUrl,
      headers,
      body,
      context: options?.context,
    };

    const fetchFn = this.config.fetch ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined);
    if (!fetchFn) {
      throw new Error("No fetch implementation available. Provide withFetch() in provideHttpClient or run in an environment with global fetch.");
    }

    const finalHandler = async (req: HttpRequestPayload): Promise<Response> => {
      return fetchFn(req.url, {
        method: req.method,
        headers: req.headers,
        body: (req.body as any) ?? undefined,
        signal: options?.signal,
      });
    };

    const pipeline = this.interceptors.reduceRight<typeof finalHandler>(
      (next, interceptor) => (req) => interceptor(req, next),
      finalHandler,
    );

    const response = await pipeline(payload);

    if (options?.observe === "response") {
      return response as unknown as T;
    }

    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        try {
          errorBody = await response.text();
        } catch {
          errorBody = null;
        }
      }
      throw new HttpErrorResponse({
        url: response.url || targetUrl,
        status: response.status,
        statusText: response.statusText,
        error: errorBody,
      });
    }

    if (options?.responseType === "text") {
      return (await response.text()) as unknown as T;
    }
    if (options?.responseType === "blob") {
      return (await response.blob()) as unknown as T;
    }

    const contentType = response.headers?.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return (await response.json()) as unknown as T;
    }

    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
}
