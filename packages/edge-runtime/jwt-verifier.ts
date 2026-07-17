import { createLocalJWKSet, jwtVerify, type JWK } from "jose";

export type EdgeRuntimeProjectSecrets = {
  anonKey?: string;
  serviceRoleKey?: string;
  jwtSecret?: string;
  jwtJwks?: { keys: JWK[] } | null;
  thirdParty?: EdgeRuntimeThirdPartyJwtPolicy | null;
};

export type EdgeRuntimeThirdPartyJwtPolicy = {
  issuer: string;
  audience: string[];
  clientId: string;
  jwtJwks: { keys: JWK[] };
};

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

export async function verifyEdgeRuntimeJwt(
  secrets: EdgeRuntimeProjectSecrets,
  authHeader: string | null | undefined,
  apikeyHeader?: string | null,
): Promise<boolean> {
  const anonKey = secrets.anonKey || "";
  const serviceRoleKey = secrets.serviceRoleKey || "";

  if (!authHeader) {
    return Boolean(
      apikeyHeader &&
      (apikeyHeader === anonKey || apikeyHeader === serviceRoleKey),
    );
  }
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return false;

  if (token === anonKey || token === serviceRoleKey) {
    return true;
  }

  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const header = decodeJwtPart(parts[0]);
  const payload = decodeJwtPart(parts[1]);
  if (!header || !payload || typeof header.alg !== "string") return false;

  if (secrets.thirdParty && isThirdPartyCandidate(header, payload, secrets.thirdParty)) {
    try {
      const verified = await jwtVerify(token, createLocalJWKSet(secrets.thirdParty.jwtJwks), {
        algorithms: ["ES256", "RS256"],
        issuer: secrets.thirdParty.issuer,
        audience: secrets.thirdParty.audience,
      });
      return verified.payload.client_id === secrets.thirdParty.clientId
        && verified.payload.role === "authenticated";
    } catch {
      return false;
    }
  }

  if (secrets.jwtJwks) {
    try {
      const localKeys = secrets.jwtJwks.keys.filter((key) => !isExternalKey(key, secrets.thirdParty ?? null));
      if (localKeys.length > 0) {
        await jwtVerify(token, createLocalJWKSet({ keys: localKeys }), {
          algorithms: ["ES256", "RS256"],
        });
        return true;
      }
    } catch {
      // Fall through to legacy HS256 verification for old tokens without kid.
    }
  }

  if (!secrets.jwtSecret) return false;
  if (header.alg !== "HS256" || (header.kid !== undefined && header.kid !== "legacy-hs256")) return false;
  try {
    await jwtVerify(token, new TextEncoder().encode(secrets.jwtSecret), {
      algorithms: ["HS256"],
    });
    return true;
  } catch {
    return false;
  }
}
