import { createLocalJWKSet, jwtVerify, type JWK } from "jose";

export type EdgeRuntimeProjectSecrets = {
  anonKey?: string;
  serviceRoleKey?: string;
  jwtSecret?: string;
  jwtJwks?: { keys: JWK[] } | null;
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

export async function verifyEdgeRuntimeJwt(
  secrets: EdgeRuntimeProjectSecrets,
  authHeader: string | null | undefined,
  apikeyHeader?: string | null,
): Promise<boolean> {
  const anonKey = secrets.anonKey || "";
  const serviceRoleKey = secrets.serviceRoleKey || "";

  if (apikeyHeader && (apikeyHeader === anonKey || apikeyHeader === serviceRoleKey)) {
    return true;
  }

  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return false;

  if (token === anonKey || token === serviceRoleKey) {
    return true;
  }

  if (secrets.jwtJwks) {
    try {
      await jwtVerify(token, createLocalJWKSet(secrets.jwtJwks));
      return true;
    } catch {
      // Fall through to legacy HS256 verification for old tokens without kid.
    }
  }

  if (!secrets.jwtSecret) return false;
  try {
    await jwtVerify(token, new TextEncoder().encode(secrets.jwtSecret));
    return true;
  } catch {
    return false;
  }
}
