import { SupaCloudApiError } from "./api-error.js";

export type SupaCloudOAuthClientType = "public" | "confidential";
export type SupaCloudOAuthClientAuthMethod = "none" | "client_secret_basic" | "client_secret_post";
type SecretMethod = Exclude<SupaCloudOAuthClientAuthMethod, "none">;
type Grant = "authorization_code" | "refresh_token";
interface ClientMetadata {
  client_id: string;
  client_name?: string;
  redirect_uris?: string[];
  grant_types?: Grant[];
  response_types?: "code"[];
  client_uri?: string;
  logo_uri?: string;
  registration_type?: "manual" | "dynamic";
  created_at?: string;
  updated_at?: string;
}
export type SupaCloudOAuthClient = ClientMetadata & (
  | { client_type: "public"; token_endpoint_auth_method?: "none"; client_secret?: never }
  | { client_type: "confidential"; token_endpoint_auth_method?: SecretMethod; client_secret?: string }
);
export type SupaCloudOAuthClientList = { clients: SupaCloudOAuthClient[] };
export type SupaCloudOAuthCreatedClient = SupaCloudOAuthClient & (
  | { client_type: "public" }
  | { client_type: "confidential"; client_secret: string }
);
export type SupaCloudOAuthSecretClient = SupaCloudOAuthClient & { client_type: "confidential"; client_secret: string };
export interface SupaCloudOAuthClientUpdate {
  redirect_uris?: string[];
  token_endpoint_auth_method?: SupaCloudOAuthClientAuthMethod;
  grant_types?: Grant[];
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
}
export type SupaCloudOAuthClientCreate = Omit<SupaCloudOAuthClientUpdate, "token_endpoint_auth_method">
  & { redirect_uris: string[] } & (
    | { client_type: "public"; token_endpoint_auth_method?: "none" }
    | { client_type: "confidential"; token_endpoint_auth_method?: SecretMethod }
    | { client_type?: never; token_endpoint_auth_method?: SupaCloudOAuthClientAuthMethod }
  );
export type SupaCloudOAuthRequest = (url: string, options: RequestInit) => Promise<Response>;
export type SupaCloudOAuthClientsOptions = { managementApiUrl: string; projectRef: string } & (
  | { getAccessToken: () => Promise<string | null> | string | null; request?: SupaCloudOAuthRequest; sessionRequest?: never }
  | { sessionRequest: SupaCloudOAuthRequest; getAccessToken?: never; request?: never }
);
export interface SupaCloudOAuthRequestOptions { signal?: AbortSignal; timeoutMs?: number }

export class SupaCloudOAuthClientError extends SupaCloudApiError {
  constructor(code: string, status = 0, readonly mutationMayHaveApplied = false) {
    super("OAuth client operation failed", status, { code, mutation_may_have_applied: mutationMayHaveApplied });
    this.name = "SupaCloudOAuthClientError";
  }
}
function invalid(): never { throw new SupaCloudOAuthClientError("INVALID_OAUTH_CLIENT_RESPONSE"); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : invalid();
}
function text(value: unknown, max = 2048): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).length > max
    || /[\u0000-\u001f\u007f]/.test(value)) return invalid();
  return value;
}
function id(value: unknown): string {
  const valueId = text(value, 36);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(valueId) ? valueId : invalid();
}
function uri(value: unknown, redirect = false): string {
  const input = text(value);
  if (!input && !redirect) return input;
  if (!input || /[\s\\#]/.test(input)) return invalid();
  let url: URL;
  try { url = new URL(input); } catch { return invalid(); }
  if (url.username || url.password || (redirect
    ? /^(javascript|data|blob|file|about):$/.test(url.protocol) : !/^https?:$/.test(url.protocol))) return invalid();
  return input;
}
function array<T>(value: unknown, decode: (value: unknown) => T, max: number): T[] {
  if (!Array.isArray(value) || !value.length || value.length > max) return invalid();
  const result = value.map((value: unknown) => decode(value));
  if (new Set(result).size !== result.length) return invalid();
  return result;
}
function method(value: unknown): SupaCloudOAuthClientAuthMethod {
  return value === "none" || value === "client_secret_basic" || value === "client_secret_post" ? value : invalid();
}
function date(value: unknown): string {
  const input = text(value, 64);
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(input);
  if (!parts) return invalid();
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > (days[month - 1] ?? 0)
    || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59
    || Number(parts[7] ?? 0) > 23 || Number(parts[8] ?? 0) > 59 || !Number.isFinite(Date.parse(input))) return invalid();
  return input;
}
function fields(data: Record<string, unknown>): SupaCloudOAuthClientUpdate {
  const result: SupaCloudOAuthClientUpdate = {};
  if (data.client_name !== undefined) result.client_name = text(data.client_name, 1024);
  if (data.redirect_uris !== undefined) result.redirect_uris = array(data.redirect_uris, value => uri(value, true), 100);
  if (data.token_endpoint_auth_method !== undefined) result.token_endpoint_auth_method = method(data.token_endpoint_auth_method);
  if (data.grant_types !== undefined) {
    result.grant_types = array(data.grant_types,
      value => value === "authorization_code" || value === "refresh_token" ? value : invalid(), 2);
  }
  if (data.client_uri !== undefined) result.client_uri = uri(data.client_uri);
  if (data.logo_uri !== undefined) result.logo_uri = uri(data.logo_uri);
  return result;
}
function decodeClient(value: unknown, secret = false): SupaCloudOAuthClient {
  const data = record(value);
  const { token_endpoint_auth_method: authMethod, ...optional } = fields(data);
  const metadata: ClientMetadata = { ...optional, client_id: id(data.client_id) };
  if (data.response_types !== undefined) metadata.response_types = array(data.response_types, value => value === "code" ? value : invalid(), 1);
  if (data.registration_type !== undefined) {
    if (data.registration_type !== "manual" && data.registration_type !== "dynamic") return invalid();
    metadata.registration_type = data.registration_type;
  }
  if (data.created_at !== undefined) metadata.created_at = date(data.created_at);
  if (data.updated_at !== undefined) metadata.updated_at = date(data.updated_at);
  if (data.client_type === "public") {
    if (data.client_secret !== undefined || authMethod !== undefined && authMethod !== "none") return invalid();
    return { ...metadata, client_type: "public", ...(authMethod === undefined ? {} : { token_endpoint_auth_method: "none" }) };
  }
  if (data.client_type !== "confidential" || authMethod === "none") return invalid();
  const result: SupaCloudOAuthClient = {
    ...metadata, client_type: "confidential",
    ...(authMethod === undefined ? {} : { token_endpoint_auth_method: authMethod }),
  };
  if (!secret && data.client_secret !== undefined) return invalid();
  if (secret) {
    const clientSecret = text(data.client_secret, 4096);
    if (!clientSecret || clientSecret !== clientSecret.trim()) return invalid();
    result.client_secret = clientSecret;
  }
  return result;
}
function decodeCreated(value: unknown): SupaCloudOAuthCreatedClient {
  const client = decodeClient(value, true);
  if (client.client_type === "public") return client;
  if (!client.client_secret) return invalid();
  return { ...client, client_secret: client.client_secret };
}
function decodeList(value: unknown): SupaCloudOAuthClientList {
  const data = record(value);
  // This is the Management contract, whose clients array is always present.
  if (!Array.isArray(data.clients) || data.clients.length > 5000) return invalid();
  const clients = data.clients.map((value: unknown) => decodeClient(value));
  if (new Set(clients.map(client => client.client_id)).size !== clients.length) return invalid();
  return { clients };
}
function updateInput(value: unknown, create = false): SupaCloudOAuthClientUpdate {
  const data = record(value);
  const allowed = ["client_name", "redirect_uris", "token_endpoint_auth_method", "grant_types", "client_uri", "logo_uri"];
  if (create) allowed.push("client_type");
  if (Object.keys(data).some(key => !allowed.includes(key))) return invalid();
  const result = fields(data);
  if (!create && !Object.keys(result).length) return invalid();
  return result;
}
function createInput(value: unknown): SupaCloudOAuthClientCreate {
  const data = record(value);
  const { token_endpoint_auth_method: authMethod, ...rest } = updateInput(value, true);
  if (!rest.redirect_uris) return invalid();
  const common = { ...rest, redirect_uris: rest.redirect_uris };
  if (data.client_type === "public") {
    if (authMethod !== undefined && authMethod !== "none") return invalid();
    return { ...common, client_type: "public", ...(authMethod === undefined ? {} : { token_endpoint_auth_method: "none" }) };
  }
  if (data.client_type === "confidential") {
    if (authMethod === "none") return invalid();
    return { ...common, client_type: "confidential", ...(authMethod === undefined ? {} : { token_endpoint_auth_method: authMethod }) };
  }
  if (data.client_type !== undefined) return invalid();
  return { ...common, ...(authMethod === undefined ? {} : { token_endpoint_auth_method: authMethod }) };
}
function validateInput<T>(decode: () => T): T {
  try { return decode(); } catch { throw new SupaCloudOAuthClientError("INVALID_OAUTH_CLIENT_INPUT"); }
}
function matches(client: SupaCloudOAuthClient, input: SupaCloudOAuthClientUpdate) {
  for (const key of ["client_name", "client_uri", "logo_uri"] as const) {
    if (input[key] !== undefined && input[key] !== (client[key] ?? "")) return invalid();
  }
  if (input.token_endpoint_auth_method !== undefined && input.token_endpoint_auth_method !== client.token_endpoint_auth_method) return invalid();
  for (const key of ["redirect_uris", "grant_types"] as const) {
    const expected = input[key], actual = client[key];
    const expectedValues = new Set<string>(expected);
    if (expected && (!actual || actual.length !== expected.length || actual.some(value => !expectedValues.has(value)))) return invalid();
  }
}
function baseUrl(value: string, session: boolean): string {
  if (/[\s\\?#]/.test(value)) return invalid();
  if (session && value === "") return "";
  let url: URL;
  try { url = new URL(value); } catch { return invalid(); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash
    || url.href.replace(/\/$/, "") !== value.replace(/\/$/, "")) return invalid();
  // Session transports use same-origin relative URLs, never a caller-supplied host.
  if (session) return invalid();
  return url.href.replace(/\/$/, "");
}
async function readText(response: Response, signal: AbortSignal, max: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0, text = "";
  try {
    signal.throwIfAborted();
    for (;;) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > max) return invalid();
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Uses Management API credentials or an explicit same-origin session transport. */
export class SupaCloudOAuthClientsClient {
  private readonly base: string;
  private readonly send: SupaCloudOAuthRequest;
  private readonly token: (() => Promise<string | null> | string | null) | null;

  constructor(options: SupaCloudOAuthClientsOptions) {
    this.base = validateInput(() => {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.projectRef)) return invalid();
      return `${baseUrl(options.managementApiUrl, options.sessionRequest !== undefined)}/v1/projects/${options.projectRef}/auth/oauth-clients`;
    });
    if (options.sessionRequest !== undefined) {
      if (typeof options.sessionRequest !== "function" || options.getAccessToken !== undefined || options.request !== undefined) {
        throw new SupaCloudOAuthClientError("INVALID_OAUTH_CLIENT_INPUT");
      }
      this.send = options.sessionRequest;
      this.token = null;
    } else {
      if (typeof options.getAccessToken !== "function" || options.request !== undefined && typeof options.request !== "function") {
        throw new SupaCloudOAuthClientError("INVALID_OAUTH_CLIENT_INPUT");
      }
      this.send = options.request ?? ((url, options) => fetch(url, options));
      this.token = options.getAccessToken;
    }
  }

  private async request<T>(
    suffix: string, method: "GET" | "POST" | "PUT" | "DELETE", body: unknown,
    status: number, decode: (value: unknown) => T, options: SupaCloudOAuthRequestOptions,
  ): Promise<T> {
    const signal = options.signal, timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new SupaCloudOAuthClientError("INVALID_OAUTH_CLIENT_INPUT");
    }
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const controller = new AbortController();
    let rejectStopped: (reason: SupaCloudOAuthClientError) => void = () => {};
    const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
    const mutation = method !== "GET";
    let sent = false;
    const stop = (code: string) => {
      controller.abort();
      rejectStopped(new SupaCloudOAuthClientError(code, 0, sent && mutation));
    };
    const abort = () => stop("OAUTH_CLIENT_REQUEST_CANCELLED");
    if (signal?.aborted) throw new SupaCloudOAuthClientError("OAUTH_CLIENT_REQUEST_CANCELLED");
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("OAUTH_CLIENT_REQUEST_TIMED_OUT"), timeoutMs);
    const work = async () => {
      const headers = new Headers({ accept: "application/json" });
      if (this.token) {
        const token = await this.token();
        controller.signal.throwIfAborted();
        if (typeof token !== "string" || !token || /[\s\u0000-\u001f\u007f]/.test(token)) {
          throw new SupaCloudOAuthClientError("OAUTH_CLIENT_TOKEN_UNAVAILABLE");
        }
        headers.set("authorization", `Bearer ${token}`);
      }
      if (encoded !== undefined) headers.set("content-type", "application/json");
      controller.signal.throwIfAborted();
      sent = true;
      const response = await this.send(`${this.base}${suffix}`, {
        method, headers, ...(encoded === undefined ? {} : { body: encoded }),
        signal: controller.signal, redirect: "error", cache: "no-store",
        credentials: this.token ? "omit" : "same-origin",
      });
      try {
        controller.signal.throwIfAborted();
        if (response.redirected || response.status >= 300 && response.status < 400) return invalid();
        if (response.status === 204 && status === 204) {
          if (await readText(response, controller.signal, 0) !== "") return invalid();
          return decode(undefined);
        }
        if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i.test(response.headers.get("content-type") ?? "")) return invalid();
        const value: unknown = JSON.parse(await readText(response, controller.signal,
          response.ok && suffix === "" && method === "GET" ? 1024 * 1024 : 64 * 1024));
        if (!response.ok) {
          const data = record(value);
          if (data.mutation_may_have_applied !== undefined && typeof data.mutation_may_have_applied !== "boolean") return invalid();
          const code = typeof data.code === "string" && /^[A-Z0-9_]{1,80}$/.test(data.code)
            ? data.code : "OAUTH_CLIENT_REQUEST_FAILED";
          throw new SupaCloudOAuthClientError(code, response.status,
            mutation && (data.mutation_may_have_applied === true || response.status >= 500));
        }
        if (response.status !== status) return invalid();
        return decode(value);
      } finally { void response.body?.cancel().catch(() => {}); }
    };
    try {
      return await Promise.race([work(), stopped]);
    } catch (error) {
      if (error instanceof SupaCloudOAuthClientError) {
        if (error.code === "INVALID_OAUTH_CLIENT_RESPONSE") {
          throw new SupaCloudOAuthClientError(error.code, error.status, sent && mutation);
        }
        throw error;
      }
      throw new SupaCloudOAuthClientError("OAUTH_CLIENT_REQUEST_FAILED", 0, sent && mutation);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  list(options: SupaCloudOAuthRequestOptions = {}): Promise<SupaCloudOAuthClientList> {
    return this.request("", "GET", undefined, 200, decodeList, options);
  }
  async get(clientId: string, options: SupaCloudOAuthRequestOptions = {}): Promise<SupaCloudOAuthClient> {
    const target = validateInput(() => id(clientId));
    return this.request(`/${target}`, "GET", undefined, 200, value => {
      const client = decodeClient(value);
      if (client.client_id !== target) return invalid();
      return client;
    }, options);
  }
  async create(input: SupaCloudOAuthClientCreate, options: SupaCloudOAuthRequestOptions = {}): Promise<SupaCloudOAuthCreatedClient> {
    const submitted = validateInput(() => createInput(input));
    return this.request("", "POST", submitted, 201, value => {
      const client = decodeCreated(value);
      matches(client, submitted);
      const expectedType = submitted.client_type ?? (submitted.token_endpoint_auth_method === "none" ? "public" : "confidential");
      if (client.client_type !== expectedType || client.registration_type !== "manual") return invalid();
      return client;
    }, options);
  }
  async update(clientId: string, input: SupaCloudOAuthClientUpdate, options: SupaCloudOAuthRequestOptions = {}): Promise<SupaCloudOAuthClient> {
    const target = validateInput(() => id(clientId)), submitted = validateInput(() => updateInput(input));
    return this.request(`/${target}`, "PUT", submitted, 200, value => {
      const client = decodeClient(value);
      if (client.client_id !== target) return invalid();
      matches(client, submitted);
      return client;
    }, options);
  }
  async delete(clientId: string, options: SupaCloudOAuthRequestOptions = {}): Promise<void> {
    const target = validateInput(() => id(clientId));
    return this.request(`/${target}`, "DELETE", undefined, 204, value => { if (value !== undefined) return invalid(); }, options);
  }
  async regenerateSecret(clientId: string, options: SupaCloudOAuthRequestOptions = {}): Promise<SupaCloudOAuthSecretClient> {
    const target = validateInput(() => id(clientId));
    return this.request(`/${target}/regenerate-secret`, "POST", undefined, 200, value => {
      const client = decodeCreated(value);
      if (client.client_id !== target || client.client_type !== "confidential") return invalid();
      return client;
    }, options);
  }
}
