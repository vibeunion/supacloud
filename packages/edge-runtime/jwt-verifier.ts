import { createLocalJWKSet, jwtVerify, type JWK, type JWTPayload } from "jose";

export const VERIFIED_JWT_SUB_HEADER = "x-supacloud-jwt-sub";

export type EdgeRuntimeJwtVerificationResult =
  | { verified: false; source: "none" }
  | {
    verified: true;
    source: "anon_key" | "service_role_key";
  }
  | {
    verified: true;
    source: "jwt";
    payload: JWTPayload;
  };

export type EdgeRuntimeAuthRuntimeMode = "local" | "owner" | "shared" | "unknown";

export type EdgeRuntimeProjectSecrets = {
  anonKey?: string;
  serviceRoleKey?: string;
  jwtSecret?: string;
  jwtJwks?: { keys: JWK[] } | null;
  thirdParty?: EdgeRuntimeThirdPartyJwtPolicy | null;
  authRuntimeMode?: EdgeRuntimeAuthRuntimeMode;
  authIssuer?: string;
};

export type EdgeRuntimeThirdPartyJwtPolicy = {
  issuer: string;
  audience: string[];
  clientId: string;
  jwtJwks: { keys: JWK[] };
};

export function normalizeEdgeRuntimeAuthRuntimeMode(
  value: unknown,
): EdgeRuntimeAuthRuntimeMode {
  if (value === "local" || value === "owner" || value === "shared") {
    return value;
  }
  return "unknown";
}

export function normalizeJwtJwks(value: unknown): { keys: JWK[] } | null {
  let parsed = value;
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const keys = (parsed as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    return null;
  }

  return { keys: keys as JWK[] };
}

export function normalizeThirdPartyJwtPolicy(value: unknown): EdgeRuntimeThirdPartyJwtPolicy | null {
  let parsed = value;
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.enabled !== undefined && record.enabled !== true) return null;
  const issuer = typeof record.issuer === "string" ? record.issuer.replace(/\/+$/, "") : "";
  const rawClientId = record.clientId ?? record.client_id;
  const clientId = typeof rawClientId === "string" ? rawClientId : "";
  const audience = Array.isArray(record.audience)
    ? record.audience.filter((item): item is string => typeof item === "string" && item.length > 0)
    : (typeof record.audience === "string" && record.audience.length > 0 ? [record.audience] : []);
  const jwtJwks = normalizeJwtJwks(record.jwtJwks ?? record.jwt_jwks);
  if (!issuer || !clientId || audience.length === 0 || !jwtJwks) return null;
  return { issuer, clientId, audience, jwtJwks };
}

export function readEdgeRuntimeProjectSecrets(
  env: Record<string, string>,
): EdgeRuntimeProjectSecrets | null {
  const authRuntimeMode = normalizeEdgeRuntimeAuthRuntimeMode(
    env.SUPACLOUD_AUTH_RUNTIME_MODE,
  );
  if (authRuntimeMode === "unknown") return null;
  const jwtJwks = normalizeJwtJwks(env.JWT_JWKS);
  if (!env.SUPABASE_ANON_KEY && !env.SUPABASE_SERVICE_ROLE_KEY && !env.JWT_SECRET && !jwtJwks) {
    return null;
  }
  return {
    anonKey: env.SUPABASE_ANON_KEY || "",
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || "",
    jwtSecret: env.JWT_SECRET || "",
    jwtJwks,
    thirdParty: normalizeThirdPartyJwtPolicy(env.SUPACLOUD_THIRD_PARTY_JWT_POLICY),
    authRuntimeMode,
    authIssuer: env.SUPACLOUD_AUTH_ISSUER || "",
  };
}

function decodeJwtPart(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isThirdPartyCandidate(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  policy: EdgeRuntimeThirdPartyJwtPolicy,
): boolean {
  const kid = typeof header.kid === "string" ? header.kid : "";
  const alg = typeof header.alg === "string" ? header.alg : "";
  return policy.jwtJwks.keys.some((key) => key.kid === kid && key.alg === alg)
    || payload.iss === policy.issuer
    || payload.client_id === policy.clientId;
}

function isExternalKey(key: JWK, policy: EdgeRuntimeThirdPartyJwtPolicy | null): boolean {
  return Boolean(policy?.jwtJwks.keys.some((external) =>
    external.kid === key.kid && external.alg === key.alg));
}

export async function verifyEdgeRuntimeJwtContext(
  secrets: EdgeRuntimeProjectSecrets,
  authHeader: string | null | undefined,
  apikeyHeader?: string | null,
): Promise<EdgeRuntimeJwtVerificationResult> {
  const anonKey = secrets.anonKey || "";
  const serviceRoleKey = secrets.serviceRoleKey || "";
  const authRuntimeMode = secrets.authRuntimeMode ?? "unknown";

  if (!authHeader) {
    if (apikeyHeader && apikeyHeader === anonKey) {
      return { verified: true, source: "anon_key" };
    }
    if (apikeyHeader && apikeyHeader === serviceRoleKey) {
      return { verified: true, source: "service_role_key" };
    }
    return { verified: false, source: "none" };
  }

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { verified: false, source: "none" };

  if (token === anonKey || token === serviceRoleKey) {
    return {
      verified: true,
      source: token === anonKey ? "anon_key" : "service_role_key",
    };
  }

  if (authRuntimeMode === "unknown") {
    return { verified: false, source: "none" };
  }

  const parts = token.split(".");
  if (parts.length !== 3) return { verified: false, source: "none" };
  const header = decodeJwtPart(parts[0]);
  const payload = decodeJwtPart(parts[1]);
  if (!header || !payload || typeof header.alg !== "string") {
    return { verified: false, source: "none" };
  }

  if (
    authRuntimeMode !== "shared"
    && secrets.thirdParty
    && isThirdPartyCandidate(header, payload, secrets.thirdParty)
  ) {
    try {
      const verified = await jwtVerify(token, createLocalJWKSet(secrets.thirdParty.jwtJwks), {
        algorithms: ["ES256", "RS256"],
        issuer: secrets.thirdParty.issuer,
        audience: secrets.thirdParty.audience,
      });
      if (
        verified.payload.client_id === secrets.thirdParty.clientId &&
        verified.payload.role === "authenticated"
      ) {
        return { verified: true, source: "jwt", payload: verified.payload };
      }
      return { verified: false, source: "none" };
    } catch {
      return { verified: false, source: "none" };
    }
  }

  if (secrets.jwtJwks) {
    try {
      const localKeys = secrets.jwtJwks.keys.filter((key) => !isExternalKey(key, secrets.thirdParty ?? null));
      if (localKeys.length > 0) {
        const sharedIssuer = authRuntimeMode === "shared"
          ? secrets.authIssuer?.trim()
          : undefined;
        if (authRuntimeMode === "shared" && !sharedIssuer) {
          return { verified: false, source: "none" };
        }
        const verified = await jwtVerify(token, createLocalJWKSet({ keys: localKeys }), {
          algorithms: ["ES256", "RS256"],
          ...(sharedIssuer ? { issuer: sharedIssuer } : {}),
        });
        if (authRuntimeMode === "shared" && verified.payload.role !== "authenticated") {
          return { verified: false, source: "none" };
        }
        return { verified: true, source: "jwt", payload: verified.payload };
      }
    } catch {
      // Local/owner modes may fall through to legacy HS256 for old tokens.
    }
  }

  if (authRuntimeMode === "shared") {
    return { verified: false, source: "none" };
  }
  if (!secrets.jwtSecret) return { verified: false, source: "none" };
  if (header.alg !== "HS256" || (header.kid !== undefined && header.kid !== "legacy-hs256")) {
    return { verified: false, source: "none" };
  }
  try {
    const verified = await jwtVerify(token, new TextEncoder().encode(secrets.jwtSecret), {
      algorithms: ["HS256"],
    });
    return { verified: true, source: "jwt", payload: verified.payload };
  } catch {
    return { verified: false, source: "none" };
  }
}

export async function verifyEdgeRuntimeJwt(
  secrets: EdgeRuntimeProjectSecrets,
  authHeader: string | null | undefined,
  apikeyHeader?: string | null,
): Promise<boolean> {
  return (await verifyEdgeRuntimeJwtContext(
    secrets,
    authHeader,
    apikeyHeader,
  )).verified;
}

const UNSAFE_VERIFIED_JWT_SUBJECT =
  /[\u0000-\u001F\u007F-\u009F\u0100-\u{10FFFF}]/u;

function verifiedJwtSubjectHeaderValue(
  subject: unknown,
): string | null {
  if (typeof subject !== "string" || subject.length === 0) return null;
  if (subject.trim() !== subject) return null;
  if (UNSAFE_VERIFIED_JWT_SUBJECT.test(subject)) return null;
  return subject;
}

/**
 * Incoming values are always removed. A verified subject is forwarded only when
 * HTTP header encoding can preserve the exact signed value.
 */
export function withVerifiedJwtContext(
  request: Request,
  subject?: string,
): Request {
  const trustedRequest = request.clone();
  const headers = trustedRequest.headers;
  headers.delete(VERIFIED_JWT_SUB_HEADER);

  const headerValue = verifiedJwtSubjectHeaderValue(subject);
  if (headerValue !== null) {
    headers.set(VERIFIED_JWT_SUB_HEADER, headerValue);
  }

  return trustedRequest;
}
