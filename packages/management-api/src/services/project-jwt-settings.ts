import { calculateJwkThumbprint, importJWK, CompactSign, compactVerify } from "jose";
import type { AuthRuntimeDescriptor } from "./auth-runtime.service";
import { resolveAuthExecutionPolicy } from "./auth-execution-policy";
import { readAuthSessionPolicy, normalizeAuthSessionPolicyPatch } from "./auth-session-policy";
import { parseProjectAuthConfig, parseOAuthServerSettings } from "../utils/project-auth-record";
import { normalizeProjectJwtKeys, normalizeProjectJwtJwks } from "../utils/project-jwt";
import { normalizeProjectRoutingConfig, resolveProjectAuthUrl } from "../utils/project-routing";

type SigningSettings = { issuer: string; jwks_url: string } & (
  | { algorithm: "ES256" | "RS256"; key_id: string; oauth_enabled: boolean; migration_status: "configured" }
  | { algorithm: null; key_id: null; oauth_enabled: false; migration_status: "not_migrated" }
);
export type JwtSettingsState = { project_ref: string } & (
  | {
    execution_mode: "local" | "owner"; authority_project_ref: string;
    policy: { access_expiry: number; refresh_rotation: boolean }; signing: SigningSettings;
  }
  | { execution_mode: "shared"; authority_project_ref: string; policy: null; signing: null }
  | { execution_mode: "external"; authority_project_ref: null; policy: null; signing: null }
);
function invalid(reason = "invalid configuration"): never { throw new Error(`JWT settings unavailable: ${reason}`); }
function validRef(value: string): boolean { return /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function label(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : invalid();
}
export function canonicalJwtIssuerUrl(value: string): string {
  if (value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return invalid();
  const url = new URL(value);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password
    || url.search || url.hash || !url.hostname) return invalid();
  const canonical = url.href.replace(/\/+$/, "");
  if (canonical !== value.replace(/\/+$/, "")) return invalid();
  return canonical;
}

export async function buildProjectJwtSettings(
  ref: string, config: Record<string, unknown>, runtime: AuthRuntimeDescriptor,
): Promise<JwtSettingsState> {
  if (!validRef(ref) || runtime.project_ref !== ref || !validRef(runtime.authority_project_ref)) return invalid();
  const policy = resolveAuthExecutionPolicy(runtime, config);
  if (policy.mode !== "external" && (policy.mode === "shared"
    ? policy.authorityRef === ref : policy.authorityRef !== ref)) return invalid();
  if (policy.mode === "shared") return {
    project_ref: ref, execution_mode: "shared", authority_project_ref: policy.authorityRef, policy: null, signing: null,
  };
  if (policy.mode === "external") return {
    project_ref: ref, execution_mode: "external", authority_project_ref: null, policy: null, signing: null,
  };
  const identity = { project_ref: ref, execution_mode: policy.mode, authority_project_ref: policy.authorityRef };
  const auth = parseProjectAuthConfig(config.auth);
  // Validate every supplied alias before using the runtime's canonical defaults.
  normalizeAuthSessionPolicyPatch(auth);
  const session = readAuthSessionPolicy(auth);
  const oauth = parseOAuthServerSettings(auth.oauth_server);
  const issuer = canonicalJwtIssuerUrl(oauth.issuer
    ?? `${resolveProjectAuthUrl(ref, normalizeProjectRoutingConfig(config)).replace(/\/+$/, "")}/auth/v1`);
  const keys = normalizeProjectJwtKeys(oauth.jwt_keys);
  const jwks = normalizeProjectJwtJwks(oauth.jwt_jwks);
  const publicState = {
    ...identity, policy: { access_expiry: session.jwt_expiry, refresh_rotation: session.refresh_token_rotation_enabled },
  };
  if (!keys && !jwks && oauth.jwt_keys === undefined && oauth.jwt_jwks === undefined) {
    if (oauth.enabled === true || oauth.signing_alg !== undefined || oauth.key_id !== undefined) return invalid();
    return { ...publicState, signing: {
      algorithm: null, key_id: null, issuer, jwks_url: `${issuer}/.well-known/jwks.json`,
      oauth_enabled: false, migration_status: "not_migrated",
    } };
  }
  if (!keys || !jwks || !keys.length || !jwks.keys.length) return invalid("invalid signing key collections");
  const algorithm = oauth.signing_alg;
  if (algorithm !== "ES256" && algorithm !== "RS256") return invalid("unsupported signing algorithm");
  const keyId = label(oauth.key_id);
  const signing = keys.filter(key => key.kid === keyId);
  const published = jwks.keys.filter(key => key.kid === keyId);
  const privateKey = signing[0];
  const publicKey = published[0];
  if (signing.length !== 1 || published.length !== 1 || !privateKey || !publicKey
    || privateKey.alg !== algorithm || publicKey.alg !== algorithm
    || privateKey.kty !== (algorithm === "ES256" ? "EC" : "RSA")
    || publicKey.kty !== privateKey.kty) return invalid("signing key identity mismatch");
  const publicKeyRecord: Record<string, unknown> = Object.fromEntries(Object.entries(publicKey));
  const privateKeyRecord: Record<string, unknown> = Object.fromEntries(Object.entries(privateKey));
  for (const field of ["d", "p", "q", "dp", "dq", "qi", "oth", "k", "priv", "aws:kms:arn"]) {
    if (publicKeyRecord[field] !== undefined) return invalid("private fields in public signing key");
  }
  if (await calculateJwkThumbprint(privateKey) !== await calculateJwkThumbprint(publicKey)) return invalid("signing key thumbprint mismatch");
  const verificationKey = await importJWK(publicKey, algorithm);
  if (verificationKey instanceof Uint8Array) return invalid();
  if (algorithm === "RS256" && (!("modulusLength" in verificationKey.algorithm)
    || typeof verificationKey.algorithm.modulusLength !== "number"
    || verificationKey.algorithm.modulusLength < 2048)) return invalid();
  const kms = privateKeyRecord["aws:kms:arn"];
  if (kms !== undefined) {
    if (algorithm !== "RS256" || typeof kms !== "string" || !/^arn:[^:]+:kms:[^:]+:[^:]+:key\/.+/.test(kms)) return invalid();
  } else {
    if (typeof privateKey.d !== "string" || !privateKey.d) return invalid();
    const signingKey = await importJWK(privateKey, algorithm);
    const proof = await new CompactSign(new TextEncoder().encode("SupaCloud JWT key consistency"))
      .setProtectedHeader({ alg: algorithm }).sign(signingKey);
    await compactVerify(proof, verificationKey, { algorithms: [algorithm] });
  }
  return { ...publicState, signing: {
    algorithm, key_id: keyId, issuer, jwks_url: `${issuer}/.well-known/jwks.json`,
    oauth_enabled: oauth.enabled === true, migration_status: "configured",
  } };
}
