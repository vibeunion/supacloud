import type { SupabaseClient } from "./supabase-types.js";
import {
  createSupaCloudApiFetch,
  getSupaCloudApiFetchError,
} from "./api-fetch.js";
import type { FetchTransport } from "./bounded-rpc-fetch.js";
import {
  SupaCloudProcedureError,
  procedureErrorIdentifier as safeIdentifier,
  type SupaCloudProcedureErrorCode,
} from "./procedure-error.js";

export {
  SupaCloudProcedureError,
  type SupaCloudProcedureErrorCode,
  type SupaCloudProcedureErrorOptions,
} from "./procedure-error.js";

export interface SupaCloudGeneratedClientConfig {
  fetch: FetchTransport;
}

export type SupaCloudGeneratedClientFactory<TClient extends object = object> = (
  config: SupaCloudGeneratedClientConfig,
) => TClient;

export interface SupaCloudProcedureClientOptions<
  TClient extends SupabaseClient,
  TFactory extends SupaCloudGeneratedClientFactory,
> {
  /** The existing user-scoped Supabase client; it owns auth and session refresh. */
  supabase: TClient;
  /** The deployed Edge Function name hosting the generated application routes. */
  functionName: string;
  /** The generated createApiClient factory for the application contract. */
  generated: TFactory;
}

export type SupaCloudProcedureClient<TFactory extends SupaCloudGeneratedClientFactory> =
  ReturnType<TFactory>;

type GeneratedError = {
  code: string;
  status: number;
  requestId?: unknown;
  response?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asGeneratedError(value: unknown): GeneratedError | undefined {
  if (!isRecord(value)) return undefined;
  if (value.name !== "ApiClientError"
    || typeof value.code !== "string" || typeof value.status !== "number") return undefined;
  return { code: value.code, status: value.status, requestId: value.requestId, response: value.response };
}

async function readErrorBody(response: Response | undefined): Promise<Record<string, unknown> | undefined> {
  if (response === undefined || response.ok || response.bodyUsed || !response.body) return undefined;
  const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json" && !type?.endsWith("+json")) return undefined;
  const maxBytes = 64 * 1024;
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) return undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  try {
    reader = response.clone().body?.getReader();
    if (!reader) return undefined;
    const current = reader;
    const read = async () => {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let bytes = 0;
      let text = "";
      while (!finished) {
        const chunk = await current.read();
        if (finished) return undefined;
        if (chunk.done) {
          const body: unknown = JSON.parse(text + decoder.decode());
          return isRecord(body) ? body : undefined;
        }
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) return undefined;
        text += decoder.decode(chunk.value, { stream: true });
      }
      return undefined;
    };
    return await Promise.race([
      read(),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 250); }),
    ]);
  } catch {
    return undefined;
  } finally {
    finished = true;
    clearTimeout(timer);
    // Cancelling a clone can await its untouched sibling; never await that here.
    void reader?.cancel().catch(() => {});
  }
}

function errorName(error: unknown): string | undefined {
  return isRecord(error) && typeof error.name === "string" ? error.name : undefined;
}

async function normalizeProcedureError(error: unknown, transport = false): Promise<unknown> {
  if (error instanceof SupaCloudProcedureError) return error;
  if (errorName(error) === "AbortError") return error;
  if (errorName(error) === "FunctionsFetchError" && isRecord(error)
    && errorName(error.context) === "AbortError") return error.context;

  const generated = asGeneratedError(error);
  const response = generated?.response instanceof Response
    ? generated.response
    : isRecord(error) && error.context instanceof Response ? error.context : undefined;
  const original = response === undefined ? undefined : getSupaCloudApiFetchError(response);
  const cause = original ?? error;
  const responseBody = await readErrorBody(response);
  const name = errorName(cause);
  const message = error instanceof Error ? error.message : "SupaCloud procedure failed";
  const fallback: SupaCloudProcedureErrorCode =
    name === "FunctionsFetchError" ? "SUPACLOUD_TRANSPORT_ERROR"
    : name === "FunctionsRelayError" ? "SUPACLOUD_FUNCTIONS_ERROR"
    : name === "FunctionsHttpError" ? "API_HTTP_ERROR"
    : error instanceof SyntaxError ? "API_RESPONSE_INVALID"
    : transport ? "SUPACLOUD_TRANSPORT_ERROR" : "SUPACLOUD_CLIENT_ERROR";
  const code = name === "FunctionsRelayError" ? fallback : generated?.code ?? fallback;
  return new SupaCloudProcedureError(message, {
    code,
    status: generated?.status ?? response?.status ?? null,
    requestId: safeIdentifier(generated?.requestId)
      ?? safeIdentifier(response?.headers.get("x-request-id"))
      ?? safeIdentifier(responseBody?.requestId) ?? null,
    details: responseBody,
    response,
    cause,
  });
}

function validateProcedureExecution(procedure: object, args: unknown[]): void {
  const metadata: unknown = Reflect.get(procedure, "__supacloudProcedure");
  if (!isRecord(metadata)) return;
  const [first, second] = args;
  const execution = second ?? (isRecord(first)
    && (Object.hasOwn(first, "idempotencyKey") || Object.hasOwn(first, "signal")) ? first : undefined);
  const key = isRecord(execution) ? execution.idempotencyKey : undefined;
  if ((metadata.idempotency === "required" && key === undefined)
    || (key !== undefined && (typeof key !== "string" || !/^[A-Za-z0-9._:-]{1,512}$/.test(key)))) {
    throw new SupaCloudProcedureError("This procedure requires a valid idempotencyKey", {
      code: "SUPACLOUD_EXECUTION_ERROR",
    });
  }
}

function wrapGeneratedClient<TClient extends object>(client: TClient): TClient {
  const cache = new WeakMap<object, object>();

  const wrap = (value: object, level: "client" | "controller" | "call"): object => {
    const cached = cache.get(value);
    if (cached !== undefined) return cached;
    const proxy = new Proxy(value, {
      async apply(current, thisArg, args: unknown[]) {
        try {
          validateProcedureExecution(current, args);
          return await Reflect.apply(current as (...input: unknown[]) => unknown, thisArg, args);
        } catch (failure) {
          throw await normalizeProcedureError(failure);
        }
      },
      get(current, key, receiver) {
        const member: unknown = Reflect.get(current, key, receiver);
        if (!Object.hasOwn(current, key)) return member;
        if (typeof member === "function" && (level === "controller"
          || (level === "client" && key === "request")
          || (level === "call" && (key === "query" || key === "mutate")))) {
          return wrap(member, "call");
        }
        if (level === "client" && isRecord(member)
          && Object.getPrototypeOf(member) === Object.prototype) {
          return wrap(member, "controller");
        }
        return member;
      },
    });
    cache.set(value, proxy);
    return proxy;
  };

  return wrap(client, "client") as TClient;
}

/**
 * Creates a typed procedure facade over a compiler-generated client while
 * reusing Supabase JS for auth, refresh and Functions transport.
 */
export function createSupaCloudProcedureClient<
  TFactory extends SupaCloudGeneratedClientFactory,
  TClient extends SupabaseClient = SupabaseClient,
>(
  options: SupaCloudProcedureClientOptions<TClient, TFactory>,
): SupaCloudProcedureClient<TFactory> {
  const transport = createSupaCloudApiFetch({
    supabase: options.supabase,
    functionName: options.functionName,
  });
  const fetch: FetchTransport = async (input, init) => {
    try {
      const response = await transport(input, init);
      const error = getSupaCloudApiFetchError(response);
      // Relay failures are not application responses, even if a schema accepts the status.
      if (error !== undefined && (response.ok || errorName(error) === "FunctionsRelayError")) throw error;
      return response;
    } catch (error) {
      throw await normalizeProcedureError(error, true);
    }
  };
  return wrapGeneratedClient(options.generated({ fetch })) as SupaCloudProcedureClient<TFactory>;
}
