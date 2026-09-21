import { GoTrueAdminApi, type OAuthClient, type CreateOAuthClientParams } from "@supabase/auth-js";
import { isRecord } from "../utils/project-config";

type Client = Pick<OAuthClient, "client_id" | "client_type">
  & Partial<Pick<OAuthClient, "client_name" | "client_secret" | "redirect_uris"
    | "token_endpoint_auth_method" | "grant_types" | "response_types" | "client_uri"
    | "logo_uri" | "registration_type" | "created_at" | "updated_at">>;
type ClientInput = Partial<Pick<Client, "client_name" | "redirect_uris" | "token_endpoint_auth_method"
  | "grant_types" | "client_uri" | "logo_uri" | "client_type">>;
export type GoTrueOAuthOperation =
  | { kind: "list" }
  | { kind: "create"; input: unknown }
  | { kind: "get" | "delete" | "regenerate"; clientId: string }
  | { kind: "update"; clientId: string; input: unknown };
export interface GoTrueOAuthContext {
  url: string;
  projectRef: string;
  adminToken: string;
  signal: AbortSignal;
  timeoutMs?: number;
}

export class GoTrueOAuthError extends Error {
  constructor(readonly status = 502, readonly mutationMayHaveApplied = false) {
    super(status === 400 ? "Invalid OAuth client input" : "GoTrue OAuth admin endpoint unavailable");
  }
}
function invalid(): never { throw new GoTrueOAuthError(); }
function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : invalid();
}
function text(value: unknown, max = 2048): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).length > max
    || /[\u0000-\u001f\u007f]/.test(value)) return invalid();
  return value;
}
function id(value: unknown): string {
  const result = text(value, 36);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(result) ? result : invalid();
}
function uri(value: unknown, redirect = false): string {
  const input = text(value);
  if (!input && !redirect) return input;
  if (!input || /[\s\\]/.test(input)) return invalid();
  let parsed: URL;
  try { parsed = new URL(input); } catch { return invalid(); }
  if (parsed.username || parsed.password || parsed.hash
    || (redirect ? /^(javascript|data|blob|file|about):$/.test(parsed.protocol)
      : !/^https?:$/.test(parsed.protocol))) return invalid();
  return input;
}
function values<T>(value: unknown, decode: (value: unknown) => T, max: number): T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length === 0 || value.length > max
    || Reflect.ownKeys(value).length !== value.length + 1) return invalid();
  const result: T[] = [];
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property || !("value" in property) || !property.enumerable) return invalid();
    const item: unknown = property.value;
    result.push(decode(item));
  }
  if (new Set(result).size !== result.length) return invalid();
  return result;
}
function method(value: unknown): NonNullable<Client["token_endpoint_auth_method"]> {
  return value === "none" || value === "client_secret_basic" || value === "client_secret_post" ? value : invalid();
}
function clientType(value: unknown): Client["client_type"] {
  return value === "public" || value === "confidential" ? value : invalid();
}
function grant(value: unknown): "authorization_code" | "refresh_token" {
  return value === "authorization_code" || value === "refresh_token" ? value : invalid();
}
function timestamp(value: unknown): string {
  const input = text(value, 64);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(input);
  if (!match) return invalid();
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > (days[month - 1] ?? 0)
    || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59
    || Number(match[7] ?? 0) > 23 || Number(match[8] ?? 0) > 59 || !Number.isFinite(Date.parse(input))) return invalid();
  return input;
}
function fields(data: Record<string, unknown>): ClientInput {
  const result: ClientInput = {};
  if (data.client_name !== undefined) result.client_name = text(data.client_name, 1024);
  if (data.client_type !== undefined) result.client_type = clientType(data.client_type);
  if (data.redirect_uris !== undefined) result.redirect_uris = values(data.redirect_uris, value => uri(value, true), 100);
  if (data.token_endpoint_auth_method !== undefined) result.token_endpoint_auth_method = method(data.token_endpoint_auth_method);
  if (data.grant_types !== undefined) result.grant_types = values(data.grant_types, grant, 2);
  if (data.client_uri !== undefined) result.client_uri = uri(data.client_uri);
  if (data.logo_uri !== undefined) result.logo_uri = uri(data.logo_uri);
  if (result.client_type && result.token_endpoint_auth_method
    && (result.client_type === "public") !== (result.token_endpoint_auth_method === "none")) return invalid();
  return result;
}
function client(value: unknown, secretAllowed: boolean): Client {
  const data = record(value);
  const result: Client = { ...fields(data), client_id: id(data.client_id), client_type: clientType(data.client_type) };
  if (data.response_types !== undefined) {
    result.response_types = values(data.response_types, value => value === "code" ? value : invalid(), 1);
  }
  if (data.registration_type !== undefined) {
    if (data.registration_type !== "manual" && data.registration_type !== "dynamic") return invalid();
    result.registration_type = data.registration_type;
  }
  if (data.created_at !== undefined) result.created_at = timestamp(data.created_at);
  if (data.updated_at !== undefined) result.updated_at = timestamp(data.updated_at);
  if (data.client_secret !== undefined) {
    if (!secretAllowed || result.client_type !== "confidential") return invalid();
    const secret = text(data.client_secret, 4096);
    if (!secret || secret !== secret.trim()) return invalid();
    result.client_secret = secret;
  }
  if (secretAllowed && result.client_type === "confidential" && !result.client_secret) return invalid();
  return result;
}
function clients(value: unknown): { clients: Client[] } {
  const data = record(value);
  // GoTrue omits the clients property when the database returns no clients.
  if (!Object.keys(data).length) return { clients: [] };
  if (!Array.isArray(data.clients) || data.clients.length > 5000) return invalid();
  const result = data.clients.map((value: unknown) => client(value, false));
  if (new Set(result.map(value => value.client_id)).size !== result.length) return invalid();
  return { clients: result };
}
function ownData(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  const source = record(value);
  if (Object.getPrototypeOf(source) !== Object.prototype && Object.getPrototypeOf(source) !== null) return invalid();
  const entries: Array<[string, unknown]> = [];
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== "string" || !allowed.includes(key)) return invalid();
    const property = Object.getOwnPropertyDescriptor(source, key);
    if (!property || !("value" in property) || !property.enumerable) return invalid();
    entries.push([key, property.value]);
  }
  return Object.fromEntries(entries);
}
function captureOperation(value: unknown): GoTrueOAuthOperation {
  const data = ownData(value, ["kind", "clientId", "input"]);
  const count = Object.keys(data).length;
  const kind = data.kind;
  switch (kind) {
    case "list":
      if (count !== 1) return invalid();
      return { kind };
    case "create":
      if (count !== 2 || !Object.hasOwn(data, "input")) return invalid();
      return { kind, input: data.input };
    case "get":
    case "delete":
    case "regenerate":
      if (count !== 2) return invalid();
      return { kind, clientId: id(data.clientId) };
    case "update":
      if (count !== 3 || !Object.hasOwn(data, "input")) return invalid();
      return { kind, clientId: id(data.clientId), input: data.input };
    default: return invalid();
  }
}
function captureContext(value: unknown): GoTrueOAuthContext & { timeoutMs: number } {
  try {
    const data = ownData(value, ["url", "projectRef", "adminToken", "signal", "timeoutMs"]);
    const { url, projectRef, adminToken, signal } = data;
    if (typeof url !== "string" || typeof projectRef !== "string" || typeof adminToken !== "string"
      || !(signal instanceof AbortSignal)) return invalid();
    const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
    if (!aborted) return invalid();
    aborted.call(signal);
    const base = new URL(url);
    if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash
      || url !== base.href.replace(/\/$/, "") || !/^[A-Za-z0-9_-]{1,128}$/.test(projectRef)
      || !adminToken || /[\s\u0000-\u001f\u007f]/.test(adminToken)) return invalid();
    const timeoutMs = data.timeoutMs === undefined ? 15_000 : data.timeoutMs;
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) return invalid();
    return { url, projectRef, adminToken, signal, timeoutMs };
  } catch {
    return invalid();
  }
}
function input(value: unknown, create: boolean): ClientInput {
  const allowed = ["client_name", "redirect_uris", "token_endpoint_auth_method", "grant_types", "client_uri", "logo_uri"];
  if (create) allowed.push("client_type");
  const data = ownData(value, allowed);
  const result = fields(data);
  if (create ? !result.redirect_uris : Object.keys(result).length === 0) return invalid();
  return result;
}
function matches(receipt: Client, submitted: ClientInput): void {
  for (const key of ["client_name", "client_uri", "logo_uri"] as const) {
    if (submitted[key] !== undefined && submitted[key] !== (receipt[key] ?? "")) return invalid();
  }
  for (const key of ["client_type", "token_endpoint_auth_method"] as const) {
    if (submitted[key] !== undefined && submitted[key] !== receipt[key]) return invalid();
  }
  for (const key of ["redirect_uris", "grant_types"] as const) {
    const expected = submitted[key], actual = receipt[key];
    if (expected && (!actual || actual.length !== expected.length || actual.some(value => !expected.includes(value)))) return invalid();
  }
}

async function responseText(response: Response, signal: AbortSignal, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let encoded = "", count = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      count += part.value.byteLength;
      if (count > maxBytes) return invalid();
      encoded += decoder.decode(part.value, { stream: true });
    }
    encoded += decoder.decode();
    return encoded;
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function json(response: Response, signal: AbortSignal, maxBytes: number): Promise<unknown> {
  if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i.test(response.headers.get("content-type") ?? "")) return invalid();
  const value: unknown = JSON.parse(await responseText(response, signal, maxBytes));
  return value;
}

/** The SDK talks to GoTrue itself. Management routing and authorization stay in the route. */
export async function requestGoTrueOAuth(contextInput: unknown, operationInput: unknown): Promise<Response> {
  let operation: GoTrueOAuthOperation;
  let submitted: ClientInput | undefined;
  try {
    operation = captureOperation(operationInput);
    if ("input" in operation) submitted = input(operation.input, operation.kind === "create");
  } catch { throw new GoTrueOAuthError(400); }
  const context = captureContext(contextInput);
  const timeoutMs = context.timeoutMs;
  const controller = new AbortController();
  const stopped = Promise.withResolvers<never>();
  const stop = () => {
    controller.abort();
    stopped.reject(new GoTrueOAuthError(504, dispatched && mutation));
  };
  const mutation = operation.kind !== "get" && operation.kind !== "list";
  let dispatched = false;
  AbortSignal.prototype.throwIfAborted.call(context.signal);
  EventTarget.prototype.addEventListener.call(context.signal, "abort", stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);
  const expectedStatus = operation.kind === "create" ? 201 : operation.kind === "delete" ? 204 : 200;
  const decode = (value: unknown) => {
    if (operation.kind === "list") return clients(value);
    const result = client(value, operation.kind === "create" || operation.kind === "regenerate");
    if ("clientId" in operation && result.client_id !== operation.clientId) return invalid();
    if (submitted) matches(result, submitted);
    if (operation.kind === "create") {
      const expectedType = submitted?.client_type ?? (submitted?.token_endpoint_auth_method === "none" ? "public" : "confidential");
      if (result.client_type !== expectedType || result.registration_type !== "manual") return invalid();
    }
    if (operation.kind === "regenerate" && result.client_type !== "confidential") return invalid();
    return result;
  };
  let transportError: GoTrueOAuthError | undefined;
  const admin = new GoTrueAdminApi({
    url: context.url,
    headers: { authorization: `Bearer ${context.adminToken}`, apikey: context.adminToken, "x-project-ref": context.projectRef },
    fetch: Object.assign(async (url: URL | RequestInfo, options?: RequestInit) => {
      controller.signal.throwIfAborted();
      dispatched = true;
      let response: Response | undefined;
      try {
        response = await fetch(url, { ...options, signal: controller.signal, redirect: "error", cache: "no-store" });
        controller.signal.throwIfAborted();
        if (response.redirected || response.status !== expectedStatus) {
          const status = [400, 404, 409, 422, 429].includes(response.status) ? response.status : 502;
          throw new GoTrueOAuthError(status, mutation && status === 502);
        }
        if (expectedStatus === 204) {
          if (await responseText(response, controller.signal, 0) !== "") return invalid();
          return new Response(null, { status: 204 });
        }
        const payload = decode(await json(response, controller.signal, operation.kind === "list" ? 1024 * 1024 : 64 * 1024));
        return Response.json(payload, { status: expectedStatus });
      } catch (error) {
        transportError = error instanceof GoTrueOAuthError
          ? new GoTrueOAuthError(error.status, error.mutationMayHaveApplied || (mutation && error.status === 502))
          : new GoTrueOAuthError(502, mutation);
        throw transportError;
      } finally { void response?.body?.cancel().catch(() => {}); }
    }, { preconnect: () => {} }),
  });
  const workflow = async () => {
    let result: { data: unknown; error: unknown };
    switch (operation.kind) {
      case "list": result = await admin.oauth.listClients(); break;
      case "get": result = await admin.oauth.getClient(operation.clientId); break;
      case "delete": result = await admin.oauth.deleteClient(operation.clientId); break;
      case "regenerate": result = await admin.oauth.regenerateClientSecret(operation.clientId); break;
      case "update": result = await admin.oauth.updateClient(operation.clientId, submitted ?? {}); break;
      case "create": {
        if (!submitted?.redirect_uris) return invalid();
        const body: CreateOAuthClientParams & ClientInput & { client_secret?: string } = {
          ...submitted, client_name: submitted.client_name ?? "", redirect_uris: submitted.redirect_uris,
        };
        if (body.client_type === "public" || body.token_endpoint_auth_method === "none") {
          body.token_endpoint_auth_method = "none";
          body.client_secret = "";
        }
        result = await admin.oauth.createClient(body);
        break;
      }
    }
    controller.signal.throwIfAborted();
    if (transportError) throw transportError;
    if (result.error) throw new GoTrueOAuthError(502, mutation && dispatched);
    if (operation.kind === "delete") return new Response(null, { status: 204 });
    // Drop SDK-generated pagination defaults: the current GoTrue list is unpaginated.
    return Response.json(decode(result.data), { status: expectedStatus });
  };
  try { return await Promise.race([workflow(), stopped.promise]); }
  finally {
    clearTimeout(timer);
    EventTarget.prototype.removeEventListener.call(context.signal, "abort", stop);
  }
}
