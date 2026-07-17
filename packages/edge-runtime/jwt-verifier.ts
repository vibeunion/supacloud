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

export async function verifyEdgeRuntimeJwtContext(
  secrets: EdgeRuntimeProjectSecrets,
  authHeader: string | null | undefined,
  apikeyHeader?: string | null,
): Promise<EdgeRuntimeJwtVerificationResult> {
  const anonKey = secrets.anonKey || "";
  const serviceRoleKey = secrets.serviceRoleKey || "";

  if (authHeader) {
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return { verified: false, source: "none" };

    if (token === anonKey || token === serviceRoleKey) {
      return {
        verified: true,
        source: token === anonKey ? "anon_key" : "service_role_key",
      };
    }

    if (secrets.jwtJwks) {
      try {
        const { payload } = await jwtVerify(token, createLocalJWKSet(secrets.jwtJwks));
        return { verified: true, source: "jwt", payload };
      } catch {
        // Fall through to legacy HS256 verification for old tokens without kid.
      }
    }

    if (secrets.jwtSecret) {
      try {
        const { payload } = await jwtVerify(
          token,
          new TextEncoder().encode(secrets.jwtSecret),
        );
        return { verified: true, source: "jwt", payload };
      } catch {
        return { verified: false, source: "none" };
      }
    }

    return { verified: false, source: "none" };
  }

  if (apikeyHeader && apikeyHeader === anonKey) {
    return { verified: true, source: "anon_key" };
  }
  if (apikeyHeader && apikeyHeader === serviceRoleKey) {
    return { verified: true, source: "service_role_key" };
  }

  return { verified: false, source: "none" };
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

/**
 * Only the Edge Runtime may set this header. Incoming values are always removed,
 * then replaced with the subject from the JWT payload verified by the gateway.
 */
export function withVerifiedJwtContext(
  request: Request,
  payload?: Pick<JWTPayload, "sub">,
): Request {
  const headers = new Headers(request.headers);
  headers.delete(VERIFIED_JWT_SUB_HEADER);

  const subject = typeof payload?.sub === "string" ? payload.sub.trim() : "";
  if (subject) {
    headers.set(VERIFIED_JWT_SUB_HEADER, subject);
  }

  return new Request(request, { headers });
}
