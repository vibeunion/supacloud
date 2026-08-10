export function normalizeProjectConfig(
  value: unknown,
): Record<string, unknown> {
  if (!value) return {};

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return {};

    try {
      const parsed = JSON.parse(trimmed);
      return isRecord(parsed) ? { ...parsed } : {};
    } catch {
      return {};
    }
  }

  return isRecord(value) ? { ...value } : {};
}

export function mergeProjectConfig(
  current: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...normalizeProjectConfig(current),
    ...patch,
  };
}

export function normalizeOAuthServerConfig(value: unknown): Record<string, unknown> {
  const config = isRecord(value) ? { ...value } : {};
  if (typeof config.authorizationPath === "string" && typeof config.authorization_path !== "string") {
    config.authorization_path = config.authorizationPath;
  }
  delete config.authorizationPath;
  return config;
}

export interface ThirdPartyAuthConfig {
  enabled: boolean;
  issuer?: string;
  jwks_url?: string;
  jwt_jwks?: unknown;
  audience?: string | string[];
  client_id?: string;
  auth_endpoint_mode: "local" | "external";
  auth_upstream?: string;
  auth_host_header?: string;
  auth_upstream_tls_insecure_skip_verify?: boolean;
  claim_mapping: Record<string, string>;
}

export type ExternalAuthEndpointConfig = ThirdPartyAuthConfig & {
  enabled: true;
  auth_endpoint_mode: "external";
  auth_upstream: string;
};

export function normalizeThirdPartyAuthConfig(value: unknown): ThirdPartyAuthConfig {
  const config = isRecord(value) ? { ...value } : {};
  const authUpstream = pickString(config.auth_upstream) || pickString(config.authUpstream);
  const mode = config.auth_endpoint_mode === "local" || config.authEndpointMode === "local"
    ? "local"
    : "external";

  return {
    enabled: config.enabled === true,
    issuer: pickString(config.issuer),
    jwks_url: pickString(config.jwks_url) || pickString(config.jwksUrl),
    jwt_jwks: config.jwt_jwks ?? config.jwtJwks,
    audience: normalizeAudience(config.audience),
    client_id: pickString(config.client_id) || pickString(config.clientId),
    auth_endpoint_mode: mode,
    auth_upstream: authUpstream,
    auth_host_header: pickString(config.auth_host_header) || pickString(config.authHostHeader),
    auth_upstream_tls_insecure_skip_verify: config.auth_upstream_tls_insecure_skip_verify === true || config.authUpstreamTlsInsecureSkipVerify === true,
    claim_mapping: normalizeClaimMapping(config.claim_mapping ?? config.claimMapping),
  };
}

export function resolveExternalAuthEndpointConfig(value: unknown): ExternalAuthEndpointConfig | null {
  const config = normalizeThirdPartyAuthConfig(value);
  if (!config.enabled || config.auth_endpoint_mode !== "external" || !config.auth_upstream) return null;
  return { ...config, enabled: true, auth_endpoint_mode: "external", auth_upstream: config.auth_upstream };
}

export function resolveProjectExternalAuthEndpointConfig(value: unknown): ExternalAuthEndpointConfig | null {
  const projectConfig = normalizeProjectConfig(value);
  const authConfig = isRecord(projectConfig.auth) ? projectConfig.auth : {};
  return resolveExternalAuthEndpointConfig(authConfig.third_party_auth);
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeAudience(value: unknown): string | string[] | undefined {
  const single = pickString(value);
  if (single) return single;
  if (!Array.isArray(value)) return undefined;
  const entries = value.map((item) => pickString(item)).filter((item): item is string => Boolean(item));
  if (entries.length === 0) return undefined;
  return Array.from(new Set(entries));
}

function normalizeClaimMapping(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const mapping: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalizedKey = pickString(key);
    const normalizedValue = pickString(raw);
    if (normalizedKey && normalizedValue) mapping[normalizedKey] = normalizedValue;
  }
  return mapping;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
