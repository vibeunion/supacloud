import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
  type JWK,
  type JWTHeaderParameters,
  type JWTPayload,
} from "jose";
import { sql as metaSql } from "../db";
import { normalizeProjectConfig } from "./project-config";

export type OidcJwtKeyMaterial = {
  key_id: string;
  signing_alg: "ES256" | "RS256";
  jwt_keys: JWK[];
  jwt_jwks: { keys: JWK[] };
};

type AwsKmsSigningJwk = JWK & {
  "aws:kms:arn": string;
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
    key_ops: ["sign"],
  };

  // GoTrue uses key_ops:["sign"] to choose the single signing key. Do not add
  // legacy HS256 here; old user sessions should re-authenticate for ES256 tokens.
  const legacyJwk = buildLegacyHs256Jwk(jwtSecret);

  return {
    key_id: keyId,
    signing_alg: "ES256",
    jwt_keys: [privateSigningJwk],
    jwt_jwks: { keys: [publicSigningJwk, legacyJwk] },
  };
}

export async function buildAwsKmsRs256JwtKeyMaterial(input: {
  aws_kms_arn: string;
  public_jwk: JWK;
  key_id?: string;
}): Promise<OidcJwtKeyMaterial> {
  const arn = input.aws_kms_arn.trim();
  if (!/^arn:[^:]+:kms:[^:]+:[^:]+:key\/.+/.test(arn)) {
    throw new Error("Invalid AWS KMS key ARN");
  }

  const publicJwk = input.public_jwk;
  if (publicJwk.kty !== "RSA" || typeof publicJwk.n !== "string" || typeof publicJwk.e !== "string") {
    throw new Error("RS256 KMS public_jwk must be an RSA public JWK with n and e");
  }

  const keyId = input.key_id?.trim() || await calculateJwkThumbprint(publicJwk);
  const publicSigningJwk: JWK = {
    ...publicJwk,
    kid: keyId,
    alg: "RS256",
    use: "sig",
    key_ops: ["verify"],
  };
  delete (publicSigningJwk as Record<string, unknown>)["aws:kms:arn"];

  const kmsSigningJwk: AwsKmsSigningJwk = {
    ...publicJwk,
    kid: keyId,
    alg: "RS256",
    use: "sig",
    key_ops: ["sign"],
    "aws:kms:arn": arn,
  };

  return {
    key_id: keyId,
    signing_alg: "RS256",
    jwt_keys: [kmsSigningJwk],
    jwt_jwks: { keys: [publicSigningJwk] },
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
  const signingKeys = (parsed as JWK[])
    .filter((k) => (k.alg === "ES256" && k.kty === "EC") || (k.alg === "RS256" && k.kty === "RSA"))
    .map((k) => {
      if (!k.key_ops) {
        return { ...k, key_ops: ["sign"] };
      }
      if (Array.isArray(k.key_ops) && !k.key_ops.includes("sign")) {
        return { ...k, key_ops: [...k.key_ops, "sign"] };
      }
      return k;
    });
  return signingKeys.length > 0 ? signingKeys : (parsed as JWK[]);
}

export async function signOidcServiceRoleJwt(
  jwtKeysValue: unknown,
  issuer: string,
  ttlSeconds = 300,
): Promise<string | null> {
  let jwtKeys: JWK[] | null = null;
  try {
    jwtKeys = normalizeProjectJwtKeys(jwtKeysValue);
  } catch {
    return null;
  }

  const signingJwk = jwtKeys?.find(
    (key) => key.alg === "ES256" && key.kty === "EC" && typeof key.d === "string",
  );
  if (!signingJwk) return null;

  try {
    const privateKey = await importJWK(signingJwk, "ES256");
    const now = Math.floor(Date.now() / 1000);
    const header: { alg: "ES256"; typ: "JWT"; kid?: string } = { alg: "ES256", typ: "JWT" };
    if (typeof signingJwk.kid === "string") header.kid = signingJwk.kid;

    return new SignJWT({ role: "service_role" })
      .setProtectedHeader(header)
      .setIssuer(issuer)
      .setIssuedAt(now)
      .setExpirationTime(now + ttlSeconds)
      .sign(privateKey);
  } catch {
    return null;
  }
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
