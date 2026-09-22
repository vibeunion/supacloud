import { SupaCloudApiError } from "./api-error.js";

export type SupaCloudOAuthServerStatus = {
  project_ref: string;
  organization_id: string | null;
  account_isolated: true;
  state_source: "configuration";
  runtime_verified: false;
  enabled: boolean;
  allow_dynamic_registration: boolean;
  issuer: string;
  authorization_path: string;
  discovery_url: string;
  oauth_authorization_server_metadata_url: string;
  jwks_url: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  registration_endpoint: string;
  warnings: string[];
} & (
  | { signing_alg: "ES256"; key_id: string; oidc_id_token_ready: true; migration_status: "oidc_es256_migrated" }
  | { signing_alg: "RS256"; key_id: string; oidc_id_token_ready: true; migration_status: "oidc_rs256_migrated" }
  | { signing_alg: "not_migrated"; key_id?: never; oidc_id_token_ready: false; migration_status: "not_migrated" }
);

export type SupaCloudAuthorizeUrlOptions = {
  clientId: string;
  redirectUri: string;
  scope?: string | string[];
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: "S256" | "plain";
  nonce?: string;
  responseType?: "code";
  resource?: string;
};

export type SupaCloudOidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  response_types_supported: string[];
  subject_types_supported: string[];
  id_token_signing_alg_values_supported: string[];
  userinfo_endpoint?: string;
  registration_endpoint?: string;
};

export type SupaCloudPublicJwk =
  | { kty: "EC"; crv: "P-256"; x: string; y: string; alg: "ES256"; kid: string; use: "sig" }
  | { kty: "RSA"; n: string; e: string; alg: "RS256"; kid: string; use: "sig" };
export type SupaCloudJwks = { keys: SupaCloudPublicJwk[] };

type Options = {
  managementApiUrl: string;
  projectRef: string;
  getAccessToken: () => Promise<string | null> | string | null;
};
type MigrationOptions = { allowDynamicRegistration?: boolean; authorizationPath?: string };

export class SupaCloudOAuthServerError extends SupaCloudApiError {
  constructor(
    message: string,
    override readonly code: string,
    readonly mutationMayHaveApplied = false,
    status = 0,
  ) {
    super(message, status, { code, mutation_may_have_applied: mutationMayHaveApplied });
    this.name = "SupaCloudOAuthServerError";
  }
}

function invalid(field = "payload"): never {
  throw new SupaCloudOAuthServerError(`Invalid OAuth Server response: ${field}`, "OAUTH_SERVER_INVALID");
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : invalid();
}
function text(value: unknown, field: string, max = 4096): string {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : invalid(field);
}
function flag(value: unknown, field: string): boolean {
  return typeof value === "boolean" ? value : invalid(field);
}
function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 64) return invalid(field);
  const result = value.map((item: unknown) => text(item, field));
  return new Set(result).size === result.length ? result : invalid(field);
}
function httpUrl(value: unknown, field: string): string {
  const input = text(value, field);
  let parsed: URL;
  try { parsed = new URL(input); } catch { return invalid(field); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password
    || /[\s\\?#]/.test(input) || parsed.href.replace(/\/$/, "") !== input.replace(/\/$/, "")) return invalid(field);
  return input;
}
function authorizationPath(value: unknown): string {
  const input = text(value, "authorization_path");
  let decoded: string;
  try { decoded = decodeURIComponent(input); } catch { return invalid("authorization_path"); }
  if (!input.startsWith("/") || [input, decoded].some(part => /[\\?#\u0000-\u001f\u007f]/.test(part)
    || part.includes("//") || part.split("/").some(segment => segment === "." || segment === ".."))) {
    return invalid("authorization_path");
  }
  return input;
}

function decodeStatus(value: unknown, projectRef: string): SupaCloudOAuthServerStatus {
  const data = record(value);
  if (data.project_ref !== projectRef) return invalid("project_ref does not match request");
  if (data.account_isolated !== true) return invalid("account_isolated");
  if (data.state_source !== "configuration") return invalid("state_source");
  if (data.runtime_verified !== false) return invalid("runtime_verified");
  const issuer = httpUrl(data.issuer, "issuer");
  if (issuer.endsWith("/")) return invalid("issuer");
  function endpoint(field: string, suffix: string): string {
    return data[field] === `${issuer}${suffix}` ? httpUrl(data[field], field) : invalid(field);
  }
  const metadata = httpUrl(data.oauth_authorization_server_metadata_url, "oauth_authorization_server_metadata_url");
  if (!new URL(metadata).pathname.endsWith("/.well-known/oauth-authorization-server/auth/v1")) {
    return invalid("oauth_authorization_server_metadata_url");
  }
  const common = {
    project_ref: projectRef,
    organization_id: data.organization_id === null ? null : text(data.organization_id, "organization_id", 128),
    account_isolated: true as const,
    state_source: "configuration" as const,
    runtime_verified: false as const,
    enabled: flag(data.enabled, "enabled"),
    allow_dynamic_registration: flag(data.allow_dynamic_registration, "allow_dynamic_registration"),
    issuer, authorization_path: authorizationPath(data.authorization_path),
    discovery_url: endpoint("discovery_url", "/.well-known/openid-configuration"),
    oauth_authorization_server_metadata_url: metadata,
    jwks_url: endpoint("jwks_url", "/.well-known/jwks.json"),
    authorization_endpoint: endpoint("authorization_endpoint", "/oauth/authorize"),
    token_endpoint: endpoint("token_endpoint", "/oauth/token"),
    userinfo_endpoint: endpoint("userinfo_endpoint", "/oauth/userinfo"),
    registration_endpoint: endpoint("registration_endpoint", "/oauth/clients/register"),
    warnings: strings(data.warnings, "warnings"),
  };
  if (data.signing_alg === "not_migrated") {
    if (data.key_id !== undefined) return invalid("key_id");
    if (data.oidc_id_token_ready !== false) return invalid("oidc_id_token_ready");
    if (data.migration_status !== "not_migrated") return invalid("migration_status");
    return { ...common, signing_alg: "not_migrated", oidc_id_token_ready: false, migration_status: "not_migrated" };
  }
  if (data.signing_alg !== "ES256" && data.signing_alg !== "RS256") return invalid("signing_alg");
  if (data.oidc_id_token_ready !== true) return invalid("oidc_id_token_ready");
  const key_id = text(data.key_id, "key_id", 256);
  if (data.signing_alg === "ES256") {
    if (data.migration_status !== "oidc_es256_migrated") return invalid("migration_status");
    return { ...common, signing_alg: "ES256", key_id, oidc_id_token_ready: true, migration_status: "oidc_es256_migrated" };
  }
  if (data.migration_status !== "oidc_rs256_migrated") return invalid("migration_status");
  return { ...common, signing_alg: "RS256", key_id, oidc_id_token_ready: true, migration_status: "oidc_rs256_migrated" };
}

function decodeDiscovery(value: unknown, status: SupaCloudOAuthServerStatus): SupaCloudOidcDiscovery {
  const data = record(value);
  for (const [key, expected] of [
    ["issuer", status.issuer], ["authorization_endpoint", status.authorization_endpoint],
    ["token_endpoint", status.token_endpoint], ["jwks_uri", status.jwks_url],
  ] as const) if (data[key] !== expected) return invalid(`discovery.${key}`);
  const responseTypes = strings(data.response_types_supported, "response_types_supported");
  const subjects = strings(data.subject_types_supported, "subject_types_supported");
  const algorithms = strings(data.id_token_signing_alg_values_supported, "id_token_signing_alg_values_supported");
  if (!responseTypes.includes("code") || subjects.length === 0
    || subjects.some(subject => subject !== "public" && subject !== "pairwise")
    || !algorithms.includes(status.signing_alg)) return invalid("discovery capabilities");
  const result: SupaCloudOidcDiscovery = {
    issuer: status.issuer, authorization_endpoint: status.authorization_endpoint,
    token_endpoint: status.token_endpoint, jwks_uri: status.jwks_url,
    response_types_supported: responseTypes, subject_types_supported: subjects,
    id_token_signing_alg_values_supported: algorithms,
  };
  for (const field of ["userinfo_endpoint", "registration_endpoint"] as const) {
    if (data[field] === undefined) continue;
    if (data[field] !== status[field]) return invalid(`discovery.${field}`);
    result[field] = status[field];
  }
  return result;
}

function base64url(value: unknown, field: string): { encoded: string; bytes: Uint8Array } {
  const encoded = text(value, field, 2048);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return invalid(field);
  let binary: string;
  try { binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/")); } catch { return invalid(field); }
  if (btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== encoded) return invalid(field);
  return { encoded, bytes: Uint8Array.from(binary, char => char.charCodeAt(0)) };
}

async function decodeJwks(value: unknown, status: SupaCloudOAuthServerStatus): Promise<SupaCloudJwks> {
  const input = record(value).keys;
  if (!Array.isArray(input) || input.length === 0 || input.length > 16) return invalid("jwks.keys");
  const keys: SupaCloudPublicJwk[] = [];
  const ids = new Set<string>();
  for (const item of input) {
    const data = record(item);
    if (["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some(field => field in data)) return invalid("private JWK");
    const kid = text(data.kid, "kid", 256);
    if (ids.has(kid)) return invalid("duplicate kid");
    ids.add(kid);
    if (data.use !== undefined && data.use !== "sig") return invalid("JWK use");
    if (data.key_ops !== undefined && (strings(data.key_ops, "key_ops").join(",") !== "verify")) return invalid("key_ops");
    let key: SupaCloudPublicJwk;
    if (data.kty === "EC") {
      if (data.crv !== "P-256" || data.alg !== "ES256") return invalid("EC algorithm");
      const x = base64url(data.x, "x"), y = base64url(data.y, "y");
      if (x.bytes.length !== 32 || y.bytes.length !== 32) return invalid("EC coordinates");
      key = { kty: "EC", crv: "P-256", x: x.encoded, y: y.encoded, alg: "ES256", kid, use: "sig" };
    } else if (data.kty === "RSA") {
      if (data.alg !== "RS256") return invalid("RSA algorithm");
      const n = base64url(data.n, "n"), e = base64url(data.e, "e");
      const first = n.bytes[0];
      if (first === undefined || first === 0 || n.bytes.length > 1024
        || (n.bytes.length - 1) * 8 + (32 - Math.clz32(first)) < 2048
        || e.bytes.length === 0 || e.bytes.length > 4 || e.bytes[0] === 0) return invalid("RSA parameters");
      const exponent = e.bytes.reduce((result, byte) => result * 256 + byte, 0);
      if (exponent < 3 || exponent % 2 === 0) return invalid("RSA exponent");
      key = { kty: "RSA", n: n.encoded, e: e.encoded, alg: "RS256", kid, use: "sig" };
    } else return invalid("JWK kty");
    try {
      await crypto.subtle.importKey("jwk", key, key.kty === "EC"
        ? { name: "ECDSA", namedCurve: "P-256" }
        : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    } catch { return invalid("JWK public material"); }
    keys.push(key);
  }
  if (!keys.some(key => key.kid === status.key_id && key.alg === status.signing_alg)) return invalid("configured JWK");
  return { keys };
}

// One budget includes credential resolution, fetch, body, decoding and configuration readback.
class Operation {
  readonly controller = new AbortController();
  mutationStarted = false;
  private readonly bodies = new Set<ReadableStream<Uint8Array>>();

  async run<T>(work: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.controller.abort();
        reject(new SupaCloudOAuthServerError("OAuth Server request timed out", "OAUTH_SERVER_TIMEOUT", this.mutationStarted));
      }, 15_000);
    });
    try { return await Promise.race([work(), timeout]); }
    catch (error) {
      if (error instanceof SupaCloudOAuthServerError) {
        throw new SupaCloudOAuthServerError(error.message, error.code,
          error.mutationMayHaveApplied || this.mutationStarted, error.status);
      }
      throw new SupaCloudOAuthServerError("OAuth Server request failed", "OAUTH_SERVER_REQUEST_FAILED", this.mutationStarted);
    } finally {
      clearTimeout(timer);
      this.controller.abort();
      for (const body of this.bodies) void body.cancel().catch(() => {});
    }
  }

  async json(url: string, init: RequestInit = {}): Promise<unknown> {
    this.controller.signal.throwIfAborted();
    const response = await fetch(url, {
      ...init, redirect: "error", credentials: "omit", cache: "no-store", signal: this.controller.signal,
    });
    if (this.controller.signal.aborted) {
      void response.body?.cancel().catch(() => {});
      this.controller.signal.throwIfAborted();
    }
    const body = response.body;
    if (body) this.bodies.add(body);
    if (response.redirected || response.status >= 300 && response.status < 400) {
      throw new SupaCloudOAuthServerError("OAuth Server returned an unsuccessful response",
        "OAUTH_SERVER_HTTP_ERROR", this.mutationStarted, response.status);
    }
    if (!body) return invalid("empty body");
    const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json" && type !== "application/jwk-set+json") return invalid("content-type");
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 65536)) return invalid("body size");
    const reader = body.getReader();
    const abort = () => { void reader.cancel().catch(() => {}); };
    this.controller.signal.addEventListener("abort", abort, { once: true });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0, content = "";
    try {
      while (true) {
        this.controller.signal.throwIfAborted();
        const chunk = await reader.read();
        this.controller.signal.throwIfAborted();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 65536) return invalid("body size");
        content += decoder.decode(chunk.value, { stream: true });
      }
      content += decoder.decode();
      const value: unknown = JSON.parse(content);
      if (response.status !== 200) {
        const data = record(value);
        const code = response.status === 503 && data.code === "SUPAUTH_DEPENDENT_REFRESH_FAILED"
          ? "SUPAUTH_DEPENDENT_REFRESH_FAILED" : "OAUTH_SERVER_HTTP_ERROR";
        throw new SupaCloudOAuthServerError("OAuth Server returned an unsuccessful response",
          code, this.mutationStarted, response.status);
      }
      return value;
    } finally {
      this.controller.signal.removeEventListener("abort", abort);
      void reader.cancel().catch(() => {});
      reader.releaseLock();
      this.bodies.delete(body);
    }
  }
}

export class SupaCloudOAuthServerClient {
  private readonly base: string;
  private readonly projectRef: string;
  private readonly getAccessToken: Options["getAccessToken"];
  constructor(options: Options) {
    if (typeof options.projectRef !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(options.projectRef)) invalid("project_ref");
    this.projectRef = options.projectRef;
    this.base = httpUrl(options.managementApiUrl, "managementApiUrl").replace(/\/$/, "")
      + `/v1/projects/${this.projectRef}/auth/oauth-server`;
    this.getAccessToken = options.getAccessToken;
  }
  private async status(operation: Operation): Promise<SupaCloudOAuthServerStatus> {
    const token = text(await this.getAccessToken(), "access token", 16384);
    return decodeStatus(await operation.json(this.base, {
      method: "GET", headers: { authorization: `Bearer ${token}` },
    }), this.projectRef);
  }
  getStatus(): Promise<SupaCloudOAuthServerStatus> {
    const operation = new Operation();
    return operation.run(() => this.status(operation));
  }
  migrateToOidc(options: MigrationOptions = {}): Promise<SupaCloudOAuthServerStatus> {
    const operation = new Operation();
    return operation.run(async () => {
      const input = record(options);
      const allow = input.allowDynamicRegistration === undefined ? false : flag(input.allowDynamicRegistration, "allowDynamicRegistration");
      const path = input.authorizationPath === undefined ? undefined : authorizationPath(input.authorizationPath);
      const before = await this.status(operation);
      const token = text(await this.getAccessToken(), "access token", 16384);
      operation.controller.signal.throwIfAborted();
      operation.mutationStarted = true;
      const after = decodeStatus(await operation.json(`${this.base}/migrate`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ allow_dynamic_registration: allow, ...(path === undefined ? {} : { authorization_path: path }) }),
      }), this.projectRef);
      if (!after.enabled || !after.oidc_id_token_ready || after.allow_dynamic_registration !== allow
        || after.authorization_path !== (path ?? before.authorization_path)
        || after.issuer !== before.issuer || after.organization_id !== before.organization_id
        || after.signing_alg !== (before.signing_alg === "not_migrated" ? "ES256" : before.signing_alg)
        || before.key_id !== undefined && after.key_id !== before.key_id) return invalid("migration receipt");
      return after;
    });
  }
  private publicDocument<T>(
    field: "discovery_url" | "jwks_url",
    decode: (value: unknown, status: SupaCloudOAuthServerStatus) => T | Promise<T>,
  ): Promise<T> {
    const operation = new Operation();
    return operation.run(async () => {
      const status = await this.status(operation);
      if (!status.enabled || !status.oidc_id_token_ready) return invalid("OAuth Server not configured");
      const value = await decode(await operation.json(status[field]), status);
      const after = await this.status(operation);
      if (JSON.stringify(status) !== JSON.stringify(after)) return invalid("configuration changed during public read");
      return value;
    });
  }
  getDiscovery(): Promise<SupaCloudOidcDiscovery> {
    return this.publicDocument("discovery_url", decodeDiscovery);
  }
  getJwks(): Promise<SupaCloudJwks> {
    return this.publicDocument("jwks_url", decodeJwks);
  }
  buildAuthorizeUrl(options: SupaCloudAuthorizeUrlOptions): Promise<string> {
    const operation = new Operation();
    return operation.run(async () => {
      const input = record(options);
      const params = new URLSearchParams();
      params.set("client_id", text(input.clientId, "clientId", 256));
      const redirect = text(input.redirectUri, "redirectUri");
      let parsed: URL;
      try { parsed = new URL(redirect); } catch { return invalid("redirectUri"); }
      if (!/^https?:$/.test(parsed.protocol) && !/^[a-z][a-z0-9+.-]*:$/.test(parsed.protocol)
        || /^(javascript|data|file|vbscript):$/.test(parsed.protocol)
        || parsed.username || parsed.password || parsed.hash || /[\s\\]/.test(redirect)) return invalid("redirectUri");
      params.set("redirect_uri", redirect);
      if (input.responseType !== undefined && input.responseType !== "code") return invalid("responseType");
      params.set("response_type", "code");
      if (input.scope !== undefined) {
        const scope = Array.isArray(input.scope) ? strings(input.scope, "scope").join(" ") : text(input.scope, "scope");
        if (!/^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/.test(scope)) return invalid("scope");
        params.set("scope", scope);
      }
      for (const field of ["state", "nonce"] as const) if (input[field] !== undefined) params.set(field, text(input[field], field));
      if (input.resource !== undefined) params.set("resource", httpUrl(input.resource, "resource"));
      if (input.codeChallenge !== undefined || input.codeChallengeMethod !== undefined) {
        const challenge = text(input.codeChallenge, "codeChallenge", 128);
        const method = input.codeChallengeMethod;
        if (method !== "S256" && method !== "plain") return invalid("codeChallengeMethod");
        if (method === "S256" ? base64url(challenge, "codeChallenge").bytes.length !== 32
          : !/^[A-Za-z0-9._~-]{43,128}$/.test(challenge)) return invalid("codeChallenge");
        params.set("code_challenge", challenge);
        params.set("code_challenge_method", method);
      }
      const status = await this.status(operation);
      if (!status.enabled) return invalid("OAuth Server disabled");
      return `${status.authorization_endpoint}?${params}`;
    });
  }
}
