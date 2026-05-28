import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  type JWK,
  type JWTHeaderParameters,
  type JWTPayload,
} from "jose";
import { sql as metaSql } from "../db";
import { normalizeProjectConfig } from "./project-config";

export type OidcJwtKeyMaterial = {
  key_id: string;
  signing_alg: "ES256";
  jwt_keys: JWK[];
  jwt_jwks: { keys: JWK[] };
};

export type ProjectJwtVerification = {
  payload: JWTPayload;
  protectedHeader: JWTHeaderParameters;
  isServiceRole: boolean;
};

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function buildLegacyHs256Jwk(jwtSecret: string): JWK {
  return {
    kty: "oct",
    k: base64UrlEncode(jwtSecret),
    kid: "legacy-hs256",
    alg: "HS256",
    use: "sig",
  };
}

export async function generateOidcJwtKeyMaterial(jwtSecret: string): Promise<OidcJwtKeyMaterial> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  const keyId = await calculateJwkThumbprint(publicJwk);

  const publicSigningJwk: JWK = {
    ...publicJwk,
    kid: keyId,
    alg: "ES256",
    use: "sig",
  };
  const privateSigningJwk: JWK = {
    ...privateJwk,
    kid: keyId,
    alg: "ES256",
    use: "sig",
  };

  // jwt_keys (signing): only ES256 private key — GoTrue uses this to sign new tokens.
  // Legacy HS256 is kept in jwt_jwks (verification) so old tokens still validate.
  const legacyJwk = buildLegacyHs256Jwk(jwtSecret);

  return {
    key_id: keyId,
    signing_alg: "ES256",
    jwt_keys: [privateSigningJwk],
    jwt_jwks: { keys: [publicSigningJwk, legacyJwk] },
  };
}

export function normalizeProjectJwtJwks(value: unknown): { keys: JWK[] } | null {
  const parsed = typeof value === "string" && value.trim().startsWith("{")
    ? JSON.parse(value)
    : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = (parsed as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || keys.length === 0) return null;
  return { keys: keys as JWK[] };
}

export function normalizeProjectJwtKeys(value: unknown): JWK[] | null {
  const parsed = typeof value === "string" && value.trim().startsWith("[")
    ? JSON.parse(value)
    : value;
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  // Only return signing-suitable keys (ES256 asymmetric). Filter out legacy
  // HS256 symmetric keys that would cause GoTrue to fail key selection.
  const signingKeys = (parsed as JWK[]).filter(
    (k) => k.alg === "ES256" && k.kty === "EC",
  );
  return signingKeys.length > 0 ? signingKeys : (parsed as JWK[]);
}

function extractJwtJwksFromConfig(config: unknown): { keys: JWK[] } | null {
  const projectConfig = normalizeProjectConfig(config);
  const auth = (projectConfig.auth || {}) as Record<string, unknown>;
  const oauthServer = (auth.oauth_server || {}) as Record<string, unknown>;
  try {
    return normalizeProjectJwtJwks(oauthServer.jwt_jwks);
  } catch {
    return null;
  }
}

export async function verifyProjectJwtPayload(
  ref: string,
  token: string,
): Promise<ProjectJwtVerification | null> {
  const cleanToken = token.replace(/^Bearer\s+/i, "");
  const [project] = await metaSql`
    SELECT jwt_secret, service_role_key, config
    FROM projects
    WHERE ref = ${ref} AND deleted_at IS NULL AND lower(status) = 'active'
    LIMIT 1
  `;

  if (!project?.jwt_secret) return null;
  const jwtJwks = extractJwtJwksFromConfig(project.config);

  if (jwtJwks) {
    try {
      const result = await jwtVerify(cleanToken, createLocalJWKSet(jwtJwks));
      return {
        payload: result.payload,
        protectedHeader: result.protectedHeader,
        isServiceRole: cleanToken === project.service_role_key,
      };
    } catch {
      // Fall back to direct HS256 verification for legacy tokens without a kid.
    }
  }

  try {
    const result = await jwtVerify(cleanToken, new TextEncoder().encode(String(project.jwt_secret)));
    return {
      payload: result.payload,
      protectedHeader: result.protectedHeader,
      isServiceRole: cleanToken === project.service_role_key,
    };
  } catch {
    return null;
  }
}
