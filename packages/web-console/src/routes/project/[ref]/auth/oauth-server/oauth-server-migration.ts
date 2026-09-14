import { requestValidatedJson } from "../../../../../lib/validated-json";

export interface OAuthServerStatus {
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
  signing_alg: "ES256" | "RS256" | "not_migrated";
  key_id: string | null;
  oidc_id_token_ready: boolean;
  migration_status: "oidc_es256_migrated" | "oidc_rs256_migrated" | "not_migrated";
}
type OAuthRequest = (url: string, options: RequestInit) => Promise<Response>;
function invalid(): never { throw new Error("Invalid OAuth configuration response"); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : invalid(); }
function text(value: unknown, max = 2048): string {
  return typeof value === "string" && !!value && value === value.trim() && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : invalid();
}
function flag(value: unknown): boolean { return typeof value === "boolean" ? value : invalid(); }
function texts(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) return invalid();
  const result = value.map((item: unknown) => text(item));
  return new Set(result).size === result.length ? result : invalid();
}
function url(value: unknown): string {
  const input = text(value);
  let parsed: URL;
  try { parsed = new URL(input); } catch { return invalid(); }
  if (/[\s\\?#]/.test(input) || !/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password
    || parsed.href.replace(/\/$/, "") !== input.replace(/\/$/, "")) return invalid();
  return input;
}
function path(value: unknown): string {
  const input = text(value);
  let decoded: string;
  try { decoded = decodeURIComponent(input); } catch { return invalid(); }
  if (!input.startsWith("/") || [input, decoded].some(value => value.includes("//")
    || /[\\?#\u0000-\u001f\u007f]/.test(value)
    || value.split("/").some(part => part === "." || part === ".."))) return invalid();
  return input;
}
export function oauthPath(ref: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(ref)) return invalid();
  return `/v1/projects/${ref}/auth/oauth-server`;
}
export function parseOAuthServerStatus(value: unknown, ref: string): OAuthServerStatus {
  oauthPath(ref);
  const data = record(value);
  if (data.project_ref !== ref || data.account_isolated !== true
    || data.state_source !== "configuration" || data.runtime_verified !== false) return invalid();
  const organization = data.organization_id === null ? null : text(data.organization_id, 128);
  const issuer = url(data.issuer);
  if (issuer.endsWith("/")) return invalid();
  const algorithm = data.signing_alg;
  if (algorithm !== "ES256" && algorithm !== "RS256" && algorithm !== "not_migrated") return invalid();
  const migrated = algorithm !== "not_migrated";
  const migration = algorithm === "ES256" ? "oidc_es256_migrated"
    : algorithm === "RS256" ? "oidc_rs256_migrated" : "not_migrated";
  if (data.migration_status !== migration || data.oidc_id_token_ready !== migrated) return invalid();
  const key = migrated ? text(data.key_id, 256) : null;
  if (!migrated && data.key_id !== undefined) return invalid();
  texts(data.warnings, 32);
  function endpoint(key: string, suffix: string): string {
    const endpoint = url(data[key]);
    return endpoint === `${issuer}${suffix}` ? endpoint : invalid();
  }
  const metadata = url(data.oauth_authorization_server_metadata_url);
  // A custom issuer can differ from the configured Auth URL used for RFC 8414.
  if (!new URL(metadata).pathname.endsWith("/.well-known/oauth-authorization-server/auth/v1")) return invalid();
  return {
    project_ref: ref, organization_id: organization, account_isolated: true,
    state_source: "configuration", runtime_verified: false,
    enabled: flag(data.enabled), allow_dynamic_registration: flag(data.allow_dynamic_registration),
    issuer, authorization_path: path(data.authorization_path),
    discovery_url: endpoint("discovery_url", "/.well-known/openid-configuration"),
    oauth_authorization_server_metadata_url: metadata,
    jwks_url: endpoint("jwks_url", "/.well-known/jwks.json"),
    authorization_endpoint: endpoint("authorization_endpoint", "/oauth/authorize"),
    token_endpoint: endpoint("token_endpoint", "/oauth/token"),
    userinfo_endpoint: endpoint("userinfo_endpoint", "/oauth/userinfo"),
    registration_endpoint: endpoint("registration_endpoint", "/oauth/clients/register"),
    signing_alg: algorithm, key_id: key, oidc_id_token_ready: migrated, migration_status: migration,
  };
}
export function readOAuthServer(ref: string, request: OAuthRequest, signal: AbortSignal) {
  return requestValidatedJson(oauthPath(ref), request, value => parseOAuthServerStatus(value, ref),
    { signal, cache: "no-store" }, { maxBytes: 32 * 1024 });
}
export async function migrateOAuthServerWithReadback(
  previous: OAuthServerStatus, allowDynamicRegistration: boolean, request: OAuthRequest, signal: AbortSignal,
): Promise<{ status: OAuthServerStatus; outcome: "applied" | "dependent_refresh_failed" }> {
  const before = { ...previous };
  const ref = before.project_ref;
  const allow = flag(allowDynamicRegistration);
  const migration = await requestValidatedJson(`${oauthPath(ref)}/migrate`, request,
    (value, httpStatus): { outcome: "applied"; status: OAuthServerStatus } | { outcome: "dependent_refresh_failed" } => {
      if (httpStatus === 200) return { outcome: "applied", status: parseOAuthServerStatus(value, ref) };
      const data = record(value);
      if (data.code !== "SUPAUTH_DEPENDENT_REFRESH_FAILED" || data.persisted !== true
        || data.runtime_applied !== true || data.dependents_applied !== false
        || data.runtime_mode !== "owner" || data.authority_project_ref !== ref
        || data.dependent_status !== "failed" && data.dependent_status !== "unknown") return invalid();
      const failed = texts(data.failed_dependents, 1000);
      if ((data.dependent_status === "failed") !== (failed.length > 0)
        || failed.some(ref => !/^[A-Za-z0-9_-]{1,128}$/.test(ref) || ref === before.project_ref)) return invalid();
      return { outcome: "dependent_refresh_failed" };
    }, {
      method: "POST", body: JSON.stringify({ allow_dynamic_registration: allow }), signal, cache: "no-store",
    }, { statuses: [200, 503], maxBytes: 32 * 1024 });
  signal.throwIfAborted();
  const status = migration.outcome === "applied" ? migration.status : await readOAuthServer(ref, request, signal);
  const expectedAlgorithm = before.signing_alg === "not_migrated" ? "ES256" : before.signing_alg;
  if (!status.enabled || !status.oidc_id_token_ready || status.allow_dynamic_registration !== allow
    || status.organization_id !== before.organization_id || status.issuer !== before.issuer
    || status.authorization_path !== before.authorization_path || status.signing_alg !== expectedAlgorithm
    || status.oauth_authorization_server_metadata_url !== before.oauth_authorization_server_metadata_url
    || before.key_id !== null && status.key_id !== before.key_id) return invalid();
  return { status, outcome: migration.outcome };
}
