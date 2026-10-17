import { HttpContext } from "./http_context";
import { HttpHeaders } from "./http_headers";
import { HttpParams } from "./http_params";
import { type HttpInterceptorFn, type HttpRequestPayload } from "./interceptor";
import { decodeHttpContract, HttpContractError, type HttpContract } from "./http_contract";
import { allowsHttpReplay, HttpReplayError, isReadMethod, replayHeaders, validateReplayPolicy, type HttpReplayPolicy } from "./http_replay";

export interface HttpClientConfig {
  baseUrl?: string;
  fetch?: typeof fetch;
}

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

// Internal transport composition. Not exported from any public package entry.
// The child borrows its parent; it never owns or destroys the parent client.
const parentHttpClients = new WeakMap<HttpClientCore, HttpClientCore>();
type HttpTransportAttempt = { method: string; url: string; body: BodyInit | null; headers: string };
type HttpReplayGuard = (attempt: HttpTransportAttempt) => void;
// Carry the original logical request's budgets across parent pipelines without
// adding a caller-settable option or exposing control state in HttpContext.
const parentReplayGuards = new WeakMap<HttpRequestOptions, readonly HttpReplayGuard[]>();

export class HttpClientCore {
  private config: HttpClientConfig;
  private interceptors: HttpInterceptorFn[];

  constructor(config: HttpClientConfig = {}, interceptors: HttpInterceptorFn[] = []) {
    this.config = { ...config };
    this.interceptors = [...interceptors];
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

    const parentClient = parentHttpClients.get(this);
    const fetchFn = this.config.fetch ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined);
    if (!fetchFn && !parentClient) {
      throw new Error("No fetch implementation available. Provide withFetch() in provideHttpClient or run in an environment with global fetch.");
    }

    const inheritedGuards = (options && parentReplayGuards.get(options)) ?? [];
    let sent: HttpTransportAttempt | undefined;
    const guardTransport: HttpReplayGuard = (attempt) => {
      const defaultReadReplay = replay === undefined && isReadMethod(method)
        && sent !== undefined && isReadMethod(sent.method) && isReadMethod(attempt.method);
      if (sent !== undefined && !defaultReadReplay && (
        !allowsHttpReplay(method, replay) || !allowsHttpReplay(attempt.method, replay)
        || attempt.method !== sent.method || attempt.url !== sent.url || attempt.body !== sent.body
        || attempt.headers !== sent.headers
      )) throw new HttpReplayError();
      sent = attempt;
    };
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
      if (parentClient) {
        // Cross the parent's full interceptor/replay boundary, preserving the
        // caller's policy and signal rather than an interceptor's replacements.
        // observe:response defers decoding until the outermost client returns.
        const forwarded: ResponseOptions = {
          headers,
          body: requestBody,
          context: req.context,
          replay,
          signal: options?.signal,
          observe: "response",
        };
        parentReplayGuards.set(forwarded, [...inheritedGuards, guardTransport]);
        return parentClient.request(requestMethod, req.url, forwarded);
      }
      // Check the actual send after every ancestor's interceptor transformations.
      // Otherwise a parent changing GET to POST could evade a child's read retry
      // budget by entering a fresh parent request for each forwarding attempt.
      const attempt = { method: requestMethod, url: req.url, body: requestBody, headers: headerFingerprint };
      for (const guard of inheritedGuards) guard(attempt);
      guardTransport(attempt);
      if (!fetchFn) throw new Error("No fetch implementation is configured");
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

/** Internal: bind a provider-created client to its nearest configured parent. */
export function delegateHttpRequestsToParent(client: HttpClientCore, parent: HttpClientCore): void {
  for (let cursor: HttpClientCore | undefined = parent; cursor; cursor = parentHttpClients.get(cursor)) {
    if (cursor === client) throw new TypeError("HTTP parent delegation cannot contain a cycle");
  }
  parentHttpClients.set(client, parent);
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
