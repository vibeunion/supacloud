import type { SupabaseClient } from "./supabase-types.js";
import type { FetchTransport } from "./bounded-rpc-fetch.js";

export interface SupaCloudApiFetchOptions<TClient extends SupabaseClient = SupabaseClient> {
  /** The existing user-scoped Supabase client. It owns auth, apikey and session refresh. */
  supabase: TClient;
  /** The deployed Edge Function name that hosts the generated application routes. */
  functionName: string;
}

type InvokeMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type InvokeOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  method?: InvokeMethod;
  signal?: AbortSignal;
};

type InvokeResult = {
  data: unknown;
  error: unknown;
  response?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return isRecord(error) && typeof error.message === "string"
    ? error.message
    : "Supabase Function invocation failed";
}

async function readRequestBody(request: Request): Promise<unknown> {
  if (request.body === null) return undefined;
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("multipart/form-data")) return request.formData();
  if (!contentType.startsWith("text/")
    && !contentType.includes("application/json")
    && !contentType.includes("+json")
    && !contentType.includes("application/x-www-form-urlencoded")) {
    return request.blob();
  }
  const text = await request.text();
  if (text.length === 0) return undefined;
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

function responseFromData(data: unknown, source?: Response): Response {
  if (data instanceof Response) return data;
  const status = source?.status ?? (data === undefined ? 204 : 200);
  const headers = source?.headers;
  const init = {
    status,
    ...(source?.statusText === undefined ? {} : { statusText: source.statusText }),
    ...(headers === undefined ? {} : { headers }),
  };
  if ([204, 205, 304].includes(status)) return new Response(null, init);
  if (data === undefined) return new Response(null, init);
  if (data instanceof Blob || data instanceof ArrayBuffer || ArrayBuffer.isView(data)
    || data instanceof ReadableStream || data instanceof FormData || typeof data === "string") {
    return new Response(data as BodyInit, init);
  }
  if (headers?.get("content-type")?.includes("json")) {
    return new Response(JSON.stringify(data), init);
  }
  return new Response(JSON.stringify(data), {
    ...init,
    headers: headers ?? { "content-type": "application/json" },
  });
}

/**
 * Adapts the generated application client to the official Supabase Function
 * transport without creating a second auth/session implementation.
 */
export function createSupaCloudApiFetch<TClient extends SupabaseClient = SupabaseClient>(
  options: SupaCloudApiFetchOptions<TClient>,
): FetchTransport {
  const functionName = options.functionName.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(functionName)) {
    throw new TypeError("functionName must be a single Supabase Function name");
  }

  const invoke = options.supabase.functions.invoke.bind(options.supabase.functions) as unknown as (
    name: string,
    invokeOptions?: InvokeOptions,
  ) => Promise<InvokeResult>;

  return async (input, init) => {
    const rawInput = input instanceof Request ? input.url : input.toString();
    const url = new URL(rawInput, "http://supacloud.local");
    const request = new Request(url, init);
    const method = request.method as InvokeMethod;
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      throw new TypeError(`Supabase Function transport does not support ${request.method}`);
    }

    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      const normalized = key.toLowerCase();
      if (normalized !== "authorization" && normalized !== "apikey" && normalized !== "content-length") {
        headers[key] = value;
      }
    });

    const body = method === "GET" ? undefined : await readRequestBody(request);
    if ((request.headers.get("content-type") ?? "").toLowerCase().includes("multipart/form-data")) {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === "content-type") delete headers[key];
      }
    }
    const invocation = await invoke(`${functionName}${url.pathname}${url.search}`, {
      ...(body === undefined ? {} : { body }),
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      method,
      signal: request.signal,
    });
    if (invocation.error !== null && invocation.error !== undefined) {
      if (invocation.response instanceof Response) return invocation.response;
      if (invocation.error instanceof Error) throw invocation.error;
      throw new Error(errorMessage(invocation.error));
    }
    return responseFromData(invocation.data, invocation.response instanceof Response ? invocation.response : undefined);
  };
}
