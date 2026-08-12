export const EDGE_RUNTIME_PREHEAT_ATTESTATION_SCHEMA =
  "supacloud.edge-runtime-preheat-attestation.v1" as const;

export type EdgeRuntimePreheatEnvIdentity = {
  loaded_revision: string | null;
  env_proof: string | null;
  load_state: "loaded" | "unverified";
  load_source: "management_api" | "stale_cache" | "file_fallback";
};

export type EdgeRuntimePreheatIdentity = {
  schema: typeof EDGE_RUNTIME_PREHEAT_ATTESTATION_SCHEMA;
  project_ref: string;
  function_slug: string;
  requested_version: string | null;
  target_version: string | null;
  resolved_version: string | null;
  artifact_sha256: string;
  verify_jwt: boolean;
  activation_id: string | null;
  runtime_instance_id: string;
  execution_profile: "foreground" | "background";
  module_env_proof: string | null;
  tenant_env: EdgeRuntimePreheatEnvIdentity;
};

export type EdgeRuntimePreheatAttestation = EdgeRuntimePreheatIdentity & {
  module_loaded: true;
};

const PROJECT_REF_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const FUNCTION_SLUG_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const CANONICAL_VERSION_PATTERN = /^(?:0|[1-9]\d{0,15})$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const HMAC_REVISION_PATTERN = /^hmac-sha256:[a-f0-9]{64}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const IDENTITY_KEYS = [
  "schema",
  "project_ref",
  "function_slug",
  "requested_version",
  "target_version",
  "resolved_version",
  "artifact_sha256",
  "verify_jwt",
  "activation_id",
  "runtime_instance_id",
  "execution_profile",
  "module_env_proof",
  "tenant_env",
] as const;
const ENV_IDENTITY_KEYS = [
  "loaded_revision",
  "env_proof",
  "load_state",
  "load_source",
] as const;

export function isCanonicalArtifactSha256(candidate: unknown): candidate is string {
  return typeof candidate === "string" && SHA256_PATTERN.test(candidate);
}

function record(candidate: unknown): Record<string, unknown> | null {
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : null;
}

function hasExactKeys(
  candidate: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(candidate);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(candidate, key));
}

function isNullableVersion(
  candidate: unknown,
  pattern: RegExp,
): candidate is string | null {
  return candidate === null
    || (typeof candidate === "string"
      && pattern.test(candidate)
      && Number.isSafeInteger(Number(candidate)));
}

function isPreheatEnvIdentity(candidate: unknown): candidate is EdgeRuntimePreheatEnvIdentity {
  const envIdentity = record(candidate);
  if (!envIdentity || !hasExactKeys(envIdentity, ENV_IDENTITY_KEYS)) return false;
  const loaded = envIdentity.load_state === "loaded";
  const revisionValid = loaded
    ? typeof envIdentity.loaded_revision === "string"
      && HMAC_REVISION_PATTERN.test(envIdentity.loaded_revision)
    : envIdentity.loaded_revision === null;
  const proofValid = loaded
    ? typeof envIdentity.env_proof === "string" && HMAC_REVISION_PATTERN.test(envIdentity.env_proof)
    : envIdentity.env_proof === null;
  return revisionValid
    && proofValid
    && (loaded || envIdentity.load_state === "unverified")
    && ["management_api", "stale_cache", "file_fallback"].includes(String(envIdentity.load_source));
}

function isIdentityRecord(
  identity: Record<string, unknown>,
): identity is EdgeRuntimePreheatIdentity {
  return identity.schema === EDGE_RUNTIME_PREHEAT_ATTESTATION_SCHEMA
    && typeof identity.project_ref === "string"
    && PROJECT_REF_PATTERN.test(identity.project_ref)
    && typeof identity.function_slug === "string"
    && FUNCTION_SLUG_PATTERN.test(identity.function_slug)
    && isNullableVersion(identity.requested_version, CANONICAL_VERSION_PATTERN)
    && isNullableVersion(identity.target_version, CANONICAL_VERSION_PATTERN)
    && isNullableVersion(identity.resolved_version, CANONICAL_VERSION_PATTERN)
    && isCanonicalArtifactSha256(identity.artifact_sha256)
    && typeof identity.verify_jwt === "boolean"
    && (identity.activation_id === null
      || (typeof identity.activation_id === "string" && UUID_PATTERN.test(identity.activation_id)))
    && typeof identity.runtime_instance_id === "string"
    && UUID_PATTERN.test(identity.runtime_instance_id)
    && (identity.execution_profile === "foreground" || identity.execution_profile === "background")
    && typeof identity.module_env_proof === "string"
    && HMAC_REVISION_PATTERN.test(identity.module_env_proof)
    && isPreheatEnvIdentity(identity.tenant_env);
}

export function isEdgeRuntimePreheatIdentity(
  candidate: unknown,
): candidate is EdgeRuntimePreheatIdentity {
  const identity = record(candidate);
  return identity !== null
    && hasExactKeys(identity, IDENTITY_KEYS)
    && isIdentityRecord(identity);
}

export function isEdgeRuntimePreheatAttestation(
  candidate: unknown,
): candidate is EdgeRuntimePreheatAttestation {
  const attestation = record(candidate);
  if (!attestation || attestation.module_loaded !== true) return false;
  const { module_loaded: _moduleLoaded, ...identity } = attestation;
  return isEdgeRuntimePreheatIdentity(identity);
}

export function preheatAttestationMatches(
  attestation: EdgeRuntimePreheatAttestation,
  expected: EdgeRuntimePreheatIdentity,
): boolean {
  return attestation.schema === expected.schema
    && attestation.project_ref === expected.project_ref
    && attestation.function_slug === expected.function_slug
    && attestation.requested_version === expected.requested_version
    && attestation.target_version === expected.target_version
    && attestation.resolved_version === expected.resolved_version
    && attestation.artifact_sha256 === expected.artifact_sha256
    && attestation.verify_jwt === expected.verify_jwt
    && attestation.activation_id === expected.activation_id
    && attestation.runtime_instance_id === expected.runtime_instance_id
    && attestation.execution_profile === expected.execution_profile
    && attestation.module_env_proof === expected.module_env_proof
    && attestation.tenant_env.loaded_revision === expected.tenant_env.loaded_revision
    && attestation.tenant_env.env_proof === expected.tenant_env.env_proof
    && attestation.tenant_env.load_state === expected.tenant_env.load_state
    && attestation.tenant_env.load_source === expected.tenant_env.load_source;
}
