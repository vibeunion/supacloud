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
import {
  normalizeOAuthServerConfig,
  normalizeProjectConfig,
  normalizeThirdPartyAuthConfig,
} from "./project-config";
import { resolveProjectAuthUrl } from "./project-routing";
import { getAuthRuntimeDescriptor } from "../services/auth-runtime.service";

export type OidcJwtKeyMaterial = {
  key_id: string;
  signing_alg: "ES256" | "RS256";
  jwt_keys: JWK[];
  jwt_jwks: { keys: JWK[] };
};

export function normalizeJwtIssuer(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\/+$/, "");
  return normalized || null;
}

type AwsKmsSigningJwk = JWK & {
  "aws:kms:arn": string;
};

export type ProjectJwtVerification = {
  payload: JWTPayload;
  protectedHeader: JWTHeaderParameters;
  isServiceRole: boolean;
};

export type ThirdPartyJwtPolicy = {
  issuer: string;
  audience: string[];
  clientId: string;
  jwtJwks: { keys: JWK[] };
};

export type ProjectJwtVerificationMaterial = {
  jwtJwks: { keys: JWK[] } | null;
  localJwks: { keys: JWK[] } | null;
  thirdParty: ThirdPartyJwtPolicy | null;
};

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

export function buildLegacyHs256Jwk(jwtSecret: string): JWK {
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

export function extractJwtJwksFromConfig(config: unknown): { keys: JWK[] } | null {
  const projectConfig = normalizeProjectConfig(config);
  const auth = (projectConfig.auth || {}) as Record<string, unknown>;
  const oauthServer = (auth.oauth_server || {}) as Record<string, unknown>;
  try {
    return normalizeProjectJwtJwks(oauthServer.jwt_jwks);
  } catch {
    return null;
  }
}

function jwkIdentity(key: JWK): string {
  const kid = typeof key.kid === "string" ? key.kid : "";
  const kty = typeof key.kty === "string" ? key.kty : "";
  const alg = typeof key.alg === "string" ? key.alg : "";
  return `${kid}|${kty}|${alg}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertThirdPartyPublicJwk(key: JWK, index: number): JWK {
  const prefix = `third_party_auth.jwt_jwks.keys[${index}]`;
  const kid = typeof key.kid === "string" ? key.kid.trim() : "";
  if (!kid) throw new Error(`${prefix}.kid is required`);
  if (kid === "legacy-hs256") throw new Error(`${prefix}.kid is reserved`);

  const record = key as Record<string, unknown>;
  for (const privateField of ["k", "d", "p", "q", "dp", "dq", "qi", "oth"]) {
    if (record[privateField] !== undefined) {
      throw new Error(`${prefix} must not contain private key material`);
    }
  }
  if (key.use !== undefined && key.use !== "sig") {
    throw new Error(`${prefix}.use must be sig`);
  }
  if (Array.isArray(key.key_ops) && (key.key_ops.includes("sign") || !key.key_ops.includes("verify"))) {
    throw new Error(`${prefix}.key_ops must only permit verification`);
  }

  if (key.kty === "EC" && key.alg === "ES256") {
    if (key.crv !== "P-256" || typeof key.x !== "string" || !key.x || typeof key.y !== "string" || !key.y) {
      throw new Error(`${prefix} must be a complete P-256 public key`);
    }
    return { ...key, kid };
  }
  if (key.kty === "RSA" && key.alg === "RS256") {
    if (typeof key.n !== "string" || !key.n || typeof key.e !== "string" || !key.e) {
      throw new Error(`${prefix} must be a complete RSA public key`);
    }
    return { ...key, kid };
  }
  throw new Error(`${prefix} must use EC/ES256 or RSA/RS256`);
}

export function resolveThirdPartyJwtPolicy(config: unknown): ThirdPartyJwtPolicy | null {
  const projectConfig = normalizeProjectConfig(config);
  const auth = (projectConfig.auth || {}) as Record<string, unknown>;
  const thirdParty = normalizeThirdPartyAuthConfig(auth.third_party_auth);
  if (!thirdParty.enabled) return null;

  if (!thirdParty.issuer) throw new Error("third_party_auth.issuer is required");
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(thirdParty.issuer);
  } catch {
    throw new Error("third_party_auth.issuer must be a valid HTTPS URL");
  }
  if (
    issuerUrl.protocol !== "https:"
    || issuerUrl.username
    || issuerUrl.password
    || issuerUrl.search
    || issuerUrl.hash
  ) {
    throw new Error("third_party_auth.issuer must be a valid HTTPS URL");
  }
  const issuer = thirdParty.issuer.replace(/\/+$/, "");

  const audience = Array.isArray(thirdParty.audience)
    ? thirdParty.audience
    : (thirdParty.audience ? [thirdParty.audience] : []);
  if (audience.length !== 1 || !audience[0]) {
    throw new Error("third_party_auth.audience must contain exactly one audience");
  }
  if (!thirdParty.client_id) throw new Error("third_party_auth.client_id is required");

  const rawJwks = normalizeProjectJwtJwks(thirdParty.jwt_jwks);
  if (!rawJwks) throw new Error("third_party_auth.jwt_jwks is required");
  const keys = rawJwks.keys.map(assertThirdPartyPublicJwk);
  const seen = new Map<string, string>();
  for (const key of keys) {
    const identity = jwkIdentity(key);
    const material = stableJson(key);
    const existing = seen.get(identity);
    if (existing && existing !== material) {
      throw new Error(`third_party_auth.jwt_jwks contains conflicting key ${String(key.kid)}`);
    }
    if (existing) throw new Error(`third_party_auth.jwt_jwks contains duplicate key ${String(key.kid)}`);
    seen.set(identity, material);
  }

  return {
    issuer,
    audience: [...audience],
    clientId: thirdParty.client_id,
    jwtJwks: { keys },
  };
}

function mergeVerificationJwks(groups: JWK[][]): { keys: JWK[] } | null {
  const keys: JWK[] = [];
  const seen = new Map<string, string>();
  for (const key of groups.flat()) {
    const identity = jwkIdentity(key);
    const material = stableJson(key);
    const existing = seen.get(identity);
    if (existing && existing !== material) {
      throw new Error(`JWT verification key conflict for ${identity}`);
    }
    if (existing) continue;
    seen.set(identity, material);
    keys.push(key);
  }
  return keys.length > 0 ? { keys } : null;
}

export function resolveProjectJwtVerificationMaterial(
  config: unknown,
  jwtSecret: string,
): ProjectJwtVerificationMaterial {
  const projectConfig = normalizeProjectConfig(config);
  const auth = (projectConfig.auth || {}) as Record<string, unknown>;
  const oauthServer = (auth.oauth_server || {}) as Record<string, unknown>;
  const localJwks = normalizeProjectJwtJwks(oauthServer.jwt_jwks);
  const thirdParty = resolveThirdPartyJwtPolicy(projectConfig);

  if (!localJwks && !thirdParty) {
    return { jwtJwks: null, localJwks: null, thirdParty: null };
  }

  return {
    jwtJwks: mergeVerificationJwks([
      localJwks?.keys || [],
      thirdParty?.jwtJwks.keys || [],
      [buildLegacyHs256Jwk(jwtSecret)],
    ]),
    localJwks,
    thirdParty,
  };
}

function publicAsymmetricKeys(jwks: { keys: JWK[] } | null): JWK[] {
  return (jwks?.keys || [])
    .filter((key) =>
      ((key.kty === "EC" && key.alg === "ES256") || (key.kty === "RSA" && key.alg === "RS256"))
      && typeof key.d !== "string"
    )
    .map((key) => {
      const publicKey = { ...key } as JWK & Record<string, unknown>;
      for (const field of ["d", "p", "q", "dp", "dq", "qi", "oth", "aws:kms:arn"]) {
        delete publicKey[field];
      }
      publicKey.key_ops = ["verify"];
      return publicKey;
    });
}

export function buildSharedProjectJwtVerificationMaterial(input: {
  ownerConfig: unknown;
}): ProjectJwtVerificationMaterial {
  const ownerConfig = normalizeProjectConfig(input.ownerConfig);
  const ownerAuth = (ownerConfig.auth || {}) as Record<string, unknown>;
  const ownerOauthServer = normalizeOAuthServerConfig(ownerAuth.oauth_server);
  const signingAlg = ownerOauthServer.signing_alg;
  const ownerSigningKeys = normalizeProjectJwtKeys(ownerOauthServer.jwt_keys);
  const signingEnabled = ownerOauthServer.enabled === true
    && (signingAlg === "ES256" || signingAlg === "RS256")
    && ownerSigningKeys?.some((key) => key.alg === signingAlg);
  const ownerKeys = publicAsymmetricKeys(extractJwtJwksFromConfig(ownerConfig));
  if (!signingEnabled || ownerKeys.length === 0) {
    throw new Error(
      "SupAuth owner must enable asymmetric ES256 or RS256 JWT signing before dependent projects can use shared authentication",
    );
  }

  // SupAuth shared mode has a single authentication authority. A dependent's
  // third-party issuer is intentionally not admitted into the shared verifier:
  // PostgREST cannot bind a payload issuer to the key that verified it, so
  // mixing external keys with owner keys would create an issuer-confusion
  // path. Third-party auth remains available in local/owner mode.
  const thirdParty: ThirdPartyJwtPolicy | null = null;
  const localJwks = { keys: ownerKeys };
  const jwtJwks = mergeVerificationJwks([ownerKeys]);
  if (!jwtJwks) throw new Error("SupAuth shared JWT verification material is empty");

  return { jwtJwks, localJwks, thirdParty };
}

export function resolveSharedAuthIssuer(ownerRef: string, ownerConfig: unknown): string {
  const normalizedOwnerConfig = normalizeProjectConfig(ownerConfig);
  const ownerAuth = (normalizedOwnerConfig.auth || {}) as Record<string, unknown>;
  const ownerOauthServer = normalizeOAuthServerConfig(ownerAuth.oauth_server);
  return normalizeJwtIssuer(ownerOauthServer.issuer)
    || `${resolveProjectAuthUrl(ownerRef, normalizedOwnerConfig)}/auth/v1`;
}

export function buildSharedProjectJwtVerifierJwks(input: {
  ownerConfig: unknown;
}): { keys: JWK[] } {
  return buildSharedProjectJwtVerificationMaterial(input).jwtJwks!;
}

export function buildSharedPostgrestJwtVerifierJwks(input: {
  projectJwtSecret: string;
  ownerConfig: unknown;
}): { keys: JWK[] } {
  const ownerJwks = buildSharedProjectJwtVerifierJwks({
    ownerConfig: input.ownerConfig,
  });
  const jwtJwks = mergeVerificationJwks([
    [buildLegacyHs256Jwk(input.projectJwtSecret)],
    ownerJwks.keys,
  ]);
  if (!jwtJwks) throw new Error("SupAuth shared PostgREST JWT verification material is empty");
  return jwtJwks;
}

/**
 * Resolve every public key accepted by a project's runtime JWT consumers.
 *
 * A project configured with third_party_auth receives user tokens from an
 * external GoTrue/OIDC issuer, while legacy anon/service-role keys remain
 * signed with the project's HS256 secret. PostgREST, Storage and the Bun
 * runtime must therefore verify against the union of both key sets.
 */
export function resolveProjectVerificationJwks(
  config: unknown,
  jwtSecret: string,
): { keys: JWK[] } | null {
  return resolveProjectJwtVerificationMaterial(config, jwtSecret).jwtJwks;
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

function isThirdPartyTokenCandidate(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  policy: ThirdPartyJwtPolicy,
): boolean {
  const kid = typeof header.kid === "string" ? header.kid : "";
  const alg = typeof header.alg === "string" ? header.alg : "";
  if (policy.jwtJwks.keys.some((key) => key.kid === kid && key.alg === alg)) return true;
  if (payload.iss === policy.issuer) return true;
  return payload.client_id === policy.clientId;
}

async function verifyThirdPartyJwt(
  token: string,
  policy: ThirdPartyJwtPolicy,
): Promise<{ payload: JWTPayload; protectedHeader: JWTHeaderParameters } | null> {
  try {
    const result = await jwtVerify(token, createLocalJWKSet(policy.jwtJwks), {
      algorithms: ["ES256", "RS256"],
      issuer: policy.issuer,
      audience: policy.audience,
    });
    if (result.payload.client_id !== policy.clientId) return null;
    if (result.payload.role !== "authenticated") return null;
    return result;
  } catch {
    return null;
  }
}

export async function verifyAsymmetricProjectJwt(
  token: string,
  localJwks: { keys: JWK[] } | null,
  issuer?: string,
): Promise<{ payload: JWTPayload; protectedHeader: JWTHeaderParameters } | null> {
  const publicKeys = (localJwks?.keys || []).filter(
    (key) => (key.kty === "EC" && key.alg === "ES256") || (key.kty === "RSA" && key.alg === "RS256"),
  );
  if (publicKeys.length === 0) return null;
  try {
    return await jwtVerify(token, createLocalJWKSet({ keys: publicKeys }), {
      algorithms: ["ES256", "RS256"],
      ...(issuer ? { issuer } : {}),
    });
  } catch {
    return null;
  }
}

async function verifyLegacyHs256Jwt(
  token: string,
  jwtSecret: string,
  header: Record<string, unknown>,
): Promise<{ payload: JWTPayload; protectedHeader: JWTHeaderParameters } | null> {
  if (header.alg !== "HS256") return null;
  if (header.kid !== undefined && header.kid !== "legacy-hs256") return null;
  try {
    return await jwtVerify(token, new TextEncoder().encode(jwtSecret), {
      algorithms: ["HS256"],
    });
  } catch {
    return null;
  }
}

export async function verifyProjectJwtPayload(
  ref: string,
  token: string,
  options: { includeProvisioning?: boolean } = {},
): Promise<ProjectJwtVerification | null> {
  const cleanToken = token.replace(/^Bearer\s+/i, "");
  const parts = cleanToken.split(".");
  if (parts.length !== 3) return null;
  const header = decodeJwtPart(parts[0]);
  const payload = decodeJwtPart(parts[1]);
  if (!header || !payload || typeof header.alg !== "string") return null;

  const [project] = options.includeProvisioning
    ? await metaSql`
      SELECT jwt_secret, anon_key, service_role_key, config
      FROM projects
      WHERE ref = ${ref}
        AND deleted_at IS NULL
        AND lower(status) IN ('active', 'creating')
      LIMIT 1
    `
    : await metaSql`
      SELECT jwt_secret, anon_key, service_role_key, config
      FROM projects
      WHERE ref = ${ref}
        AND deleted_at IS NULL
        AND lower(status) = 'active'
      LIMIT 1
    `;

  if (!project?.jwt_secret) return null;

  const authRuntime = getAuthRuntimeDescriptor(ref);
  let material: ProjectJwtVerificationMaterial;
  let sharedAuthIssuer: string | undefined;
  if (authRuntime.mode === "shared") {
    const [owner] = await metaSql`
      SELECT config
      FROM projects
      WHERE ref = ${authRuntime.authority_project_ref}
        AND deleted_at IS NULL
        AND lower(status) = 'active'
      LIMIT 1
    `;
    if (!owner) return null;
    sharedAuthIssuer = resolveSharedAuthIssuer(authRuntime.authority_project_ref, owner.config);
    material = buildSharedProjectJwtVerificationMaterial({
      ownerConfig: owner.config,
    });
  } else {
    material = resolveProjectJwtVerificationMaterial(project.config, String(project.jwt_secret));
  }

  let result: { payload: JWTPayload; protectedHeader: JWTHeaderParameters } | null = null;
  if (material.thirdParty && isThirdPartyTokenCandidate(header, payload, material.thirdParty)) {
    result = await verifyThirdPartyJwt(cleanToken, material.thirdParty);
  } else {
    result = await verifyAsymmetricProjectJwt(cleanToken, material.localJwks, sharedAuthIssuer);
    if (result && authRuntime.mode === "shared" && result.payload.role !== "authenticated") {
      return null;
    }
    if (!result && authRuntime.mode === "shared") {
      const isLegacyApiKey = cleanToken === project.anon_key || cleanToken === project.service_role_key;
      if (!isLegacyApiKey) return null;
      result = await verifyLegacyHs256Jwt(cleanToken, String(project.jwt_secret), header);
    } else if (!result) {
      result = await verifyLegacyHs256Jwt(cleanToken, String(project.jwt_secret), header);
    }
  }
  if (!result) return null;

  return {
    payload: result.payload,
    protectedHeader: result.protectedHeader,
    isServiceRole: cleanToken === project.service_role_key,
  };
}
