import { Injectable } from "./decorators";
import { HttpContext } from "./http_context";
import { HttpHeaders } from "./http_headers";
import { HttpParams } from "./http_params";
import { type HttpInterceptorFn, type HttpRequestPayload } from "./interceptor";
import { InjectionToken } from "./token";
import { inject, injectAll } from "./inject";
import { makeEnvironmentProviders, type EnvironmentProviders, type Provider } from "./provider";
import { decodeHttpContract, HttpContractError, type HttpContract } from "./http_contract";
import { allowsHttpReplay, HttpReplayError, isReadMethod, replayHeaders, validateReplayPolicy, type HttpReplayPolicy } from "./http_replay";

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
  /** Writes default to single send, including through authentication interceptors. */
  replay?: HttpReplayPolicy;
}

type ResponseOptions = HttpRequestOptions & { observe: "response" };
type TextOptions = HttpRequestOptions & { observe?: "body"; responseType: "text" };
type BlobOptions = HttpRequestOptions & { observe?: "body"; responseType: "blob" };

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

  get(url: string, options: ResponseOptions): Promise<Response>;
  get(url: string, options: TextOptions): Promise<string>;
  get(url: string, options: BlobOptions): Promise<Blob>;
  get(url: string, options?: HttpRequestOptions): Promise<unknown>;
  get(url: string, options?: HttpRequestOptions): Promise<unknown> {
    return this.request("GET", url, options);
  }

  post(url: string, body: unknown, options: ResponseOptions): Promise<Response>;
  post(url: string, body: unknown, options: TextOptions): Promise<string>;
  post(url: string, body: unknown, options: BlobOptions): Promise<Blob>;
  post(url: string, body?: unknown, options?: HttpRequestOptions): Promise<unknown>;
  post(url: string, body?: unknown, options?: HttpRequestOptions): Promise<unknown> {
    return this.request("POST", url, { ...options, body });
  }

  put(url: string, body: unknown, options: ResponseOptions): Promise<Response>;
  put(url: string, body: unknown, options: TextOptions): Promise<string>;
  put(url: string, body: unknown, options: BlobOptions): Promise<Blob>;
  put(url: string, body?: unknown, options?: HttpRequestOptions): Promise<unknown>;
  put(url: string, body?: unknown, options?: HttpRequestOptions): Promise<unknown> {
    return this.request("PUT", url, { ...options, body });
  }

  delete(url: string, options: ResponseOptions): Promise<Response>;
  delete(url: string, options: TextOptions): Promise<string>;
  delete(url: string, options: BlobOptions): Promise<Blob>;
  delete(url: string, options?: HttpRequestOptions): Promise<unknown>;
  delete(url: string, options?: HttpRequestOptions): Promise<unknown> {
    return this.request("DELETE", url, options);
  }

  patch(url: string, body: unknown, options: ResponseOptions): Promise<Response>;
  patch(url: string, body: unknown, options: TextOptions): Promise<string>;
  patch(url: string, body: unknown, options: BlobOptions): Promise<Blob>;
  patch(url: string, body?: unknown, options?: HttpRequestOptions): Promise<unknown>;
  patch(url: string, body?: unknown, options?: HttpRequestOptions): Promise<unknown> {
    return this.request("PATCH", url, { ...options, body });
  }

  /** Decoders own the input/result types; this entry never retries a failed command. */
  async execute<Input, Result>(
    contract: HttpContract<Input, Result>,
    input: NoInfer<Input>,
    options?: Omit<HttpRequestOptions, "body" | "observe" | "responseType">,
  ): Promise<Result> {
    const request = contract.request(decodeHttpContract(contract.input, input, "request"));
    const response = await this.request(request.method, request.url, {
      ...options, body: request.body, observe: "response",
    });
    if (!response.ok) {
      throw new HttpErrorResponse({
        url: response.url || request.url,
        status: response.status,
        statusText: response.statusText,
        error: await response.json().catch(() => null),
      });
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      // A successful HTTP status does not establish a valid JSON receipt.
      throw new HttpContractError("response");
    }
    return decodeHttpContract(contract.result, value, "response");
  }

  request(method: string, url: string, options: ResponseOptions): Promise<Response>;
  request(method: string, url: string, options: TextOptions): Promise<string>;
  request(method: string, url: string, options: BlobOptions): Promise<Blob>;
  request(method: string, url: string, options?: HttpRequestOptions): Promise<unknown>;
  async request(method: string, url: string, options?: HttpRequestOptions): Promise<unknown> {
    const replay = validateReplayPolicy(options?.replay);
    let targetUrl = url;
    if (this.config.baseUrl && !/^https?:\/\//i.test(targetUrl)) {
      const base = this.config.baseUrl.endsWith("/") ? this.config.baseUrl.slice(0, -1) : this.config.baseUrl;
      const rel = targetUrl.startsWith("/") ? targetUrl : `/${targetUrl}`;
      targetUrl = `${base}${rel}`;
    }

    if (options?.params) {
      const params = options.params instanceof HttpParams
        ? options.params
        : new HttpParams({ fromObject: options.params });
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
      !(body instanceof ArrayBuffer) &&
      !ArrayBuffer.isView(body) &&
      !(body instanceof ReadableStream)
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
      ...(options?.context === undefined ? {} : { context: options.context }),
      ...(replay === undefined ? {} : { replay: { ...replay } }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    };

    const fetchFn = this.config.fetch ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined);
    if (!fetchFn) {
      throw new Error("No fetch implementation available. Provide withFetch() in provideHttpClient or run in an environment with global fetch.");
    }

    let sent: { method: string; url: string; body: BodyInit | null; headers: string } | undefined;
    const finalHandler = async (req: HttpRequestPayload): Promise<Response> => {
      options?.signal?.throwIfAborted();
      const requestBody = transportBody(req.body);
      const requestMethod = req.method.toUpperCase();
      const headers = replayHeaders(req.headers, replay);
      if (replay?.mode === "idempotent") {
        if (requestBody !== null && typeof requestBody !== "string" && !(requestBody instanceof Blob)) {
          throw new TypeError("Idempotent replay requires an immutable HTTP body");
        }
      }
      const stableHeaders = new Headers(headers);
      stableHeaders.delete("authorization");
      const headerFingerprint = JSON.stringify([...stableHeaders]);
      const defaultReadReplay = replay === undefined && isReadMethod(method)
        && sent !== undefined && isReadMethod(sent.method) && isReadMethod(requestMethod);
      if (sent !== undefined && !defaultReadReplay && (
        !allowsHttpReplay(method, replay) || !allowsHttpReplay(requestMethod, replay)
        || requestMethod !== sent.method || req.url !== sent.url || requestBody !== sent.body
        || headerFingerprint !== sent.headers
      )) throw new HttpReplayError();
      sent = { method: requestMethod, url: req.url, body: requestBody, headers: headerFingerprint };
      return fetchFn(req.url, {
        method: requestMethod,
        headers,
        body: requestBody,
        ...(!isReadMethod(requestMethod) || replay !== undefined ? { redirect: "error" as const } : {}),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
    };

    const pipeline = this.interceptors.reduceRight<typeof finalHandler>(
      (next, interceptor) => (req) => interceptor(req, next),
      finalHandler,
    );

    const response = await pipeline(payload);

    if (options?.observe === "response") {
      return response;
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
      return response.text();
    }
    if (options?.responseType === "blob") {
      return response.blob();
    }

    const contentType = response.headers?.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const value: unknown = await response.json();
      return value;
    }

    const text = await response.text();
    try {
      const value: unknown = JSON.parse(text);
      return value;
    } catch {
      return text;
    }
  }
}

function transportBody(value: unknown): BodyInit | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || value instanceof Blob || value instanceof FormData
    || value instanceof URLSearchParams || value instanceof ArrayBuffer
    || value instanceof ReadableStream) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  throw new TypeError("HTTP body must be serialized before transport");
}
