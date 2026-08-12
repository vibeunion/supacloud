import { ATTESTED_REVISION_PATTERN } from "./runtime-revision";

const PREHEAT_SCHEMA = "supacloud.edge-runtime-preheat-attestation.v1";
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RESPONSE_KEYS = [
  "preheated",
  "version",
  "success",
  "attestation",
  "foreground",
  "background",
] as const;
const ATTESTATION_KEYS = [
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
  "module_loaded",
] as const;
const ENV_KEYS = [
  "loaded_revision",
  "env_proof",
  "load_state",
  "load_source",
] as const;
const POOL_KEYS = [
  "attempted",
  "succeeded",
  "cacheHits",
  "cacheMisses",
  "durationMs",
  "attestation",
] as const;
const ROTATION_KEYS = [
  "generation",
  "attempted",
  "idleRetired",
  "busyTainted",
  "alreadyTainted",
  "immediateReplacements",
] as const;

export type ExpectedEdgeRuntimePreheat = {
  projectRef: string;
  functionSlug: string;
  requestedVersion: string | null;
  resolvedVersion: string | null;
  artifactSha256: string;
  verifyJwt: boolean;
  activationId: string | null;
};

export type ValidatedPreheatPool = {
  attempted: number;
  succeeded: number;
  cacheHits: number;
  cacheMisses: number;
  durationMs: number;
  generation: number | null;
};

export type ValidatedEdgeRuntimePreheat = {
  identity: RuntimeAttestation;
  foreground: ValidatedPreheatPool;
  background: ValidatedPreheatPool;
};

export type RuntimeAttestation = {
  runtimeInstanceId: string;
  loadedRevision: string;
  envProof: string;
  verifyJwt: boolean;
  activationId: string | null;
  executionProfile: "foreground" | "background";
  moduleEnvProof: string;
};

type ValidatedPool = ValidatedPreheatPool & {
  attestation: RuntimeAttestation | null;
};

function objectRecord(candidate: unknown): Record<string, unknown> | null {
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : null;
}

function exactKeys(candidate: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(candidate).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expectedKeys[index]);
}

function exactOptionalKeys(
  candidate: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(candidate);
  return required.every((key) => Object.hasOwn(candidate, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function nonNegativeInteger(candidate: unknown): candidate is number {
  return typeof candidate === "number"
    && Number.isSafeInteger(candidate)
    && candidate >= 0;
}

function loadedEnvironment(candidate: unknown): {
  loadedRevision: string;
  envProof: string;
} | null {
  const environment = objectRecord(candidate);
  if (!environment || !exactKeys(environment, ENV_KEYS)) return null;
  if (environment.load_state !== "loaded" || environment.load_source !== "management_api") {
    return null;
  }
  if (typeof environment.loaded_revision !== "string"
    || !ATTESTED_REVISION_PATTERN.test(environment.loaded_revision)
    || typeof environment.env_proof !== "string"
    || !ATTESTED_REVISION_PATTERN.test(environment.env_proof)) return null;
  return {
    loadedRevision: environment.loaded_revision,
    envProof: environment.env_proof,
  };
}

function runtimeAttestation(
  candidate: unknown,
  expected: ExpectedEdgeRuntimePreheat,
  executionProfile: RuntimeAttestation["executionProfile"],
): RuntimeAttestation | null {
  const attestation = objectRecord(candidate);
  if (!attestation || !exactKeys(attestation, ATTESTATION_KEYS)) return null;
  const environment = loadedEnvironment(attestation.tenant_env);
  const resolvedVersion = expected.resolvedVersion;
  if (!environment
    || attestation.schema !== PREHEAT_SCHEMA
    || attestation.project_ref !== expected.projectRef
    || attestation.function_slug !== expected.functionSlug
    || attestation.requested_version !== expected.requestedVersion
    || attestation.target_version !== resolvedVersion
    || attestation.resolved_version !== resolvedVersion
    || attestation.artifact_sha256 !== expected.artifactSha256
    || attestation.verify_jwt !== expected.verifyJwt
    || attestation.activation_id !== expected.activationId
    || (attestation.activation_id !== null
      && (typeof attestation.activation_id !== "string"
        || !UUID_PATTERN.test(attestation.activation_id)))
    || !SHA256_PATTERN.test(expected.artifactSha256)
    || typeof attestation.runtime_instance_id !== "string"
    || !UUID_PATTERN.test(attestation.runtime_instance_id)
    || attestation.execution_profile !== executionProfile
    || typeof attestation.module_env_proof !== "string"
    || !ATTESTED_REVISION_PATTERN.test(attestation.module_env_proof)
    || attestation.module_loaded !== true) return null;
  return {
    runtimeInstanceId: attestation.runtime_instance_id,
    verifyJwt: attestation.verify_jwt,
    activationId: attestation.activation_id as string | null,
    executionProfile,
    moduleEnvProof: attestation.module_env_proof,
    ...environment,
  };
}

function rotationGeneration(candidate: unknown): number | null {
  const rotation = objectRecord(candidate);
  if (rotation === null
    || !exactKeys(rotation, ROTATION_KEYS)
    || !ROTATION_KEYS.every((key) => nonNegativeInteger(rotation[key]))) return null;
  const attempted = rotation.attempted as number;
  const idleRetired = rotation.idleRetired as number;
  const busyTainted = rotation.busyTainted as number;
  const alreadyTainted = rotation.alreadyTainted as number;
  if (attempted !== idleRetired + busyTainted + alreadyTainted
    || rotation.immediateReplacements !== idleRetired) return null;
  return rotation.generation as number;
}

function validatedPool(
  candidate: unknown,
  expected: ExpectedEdgeRuntimePreheat,
  executionProfile: RuntimeAttestation["executionProfile"],
): ValidatedPool | null {
  const pool = objectRecord(candidate);
  const optionalKeys = expected.requestedVersion === null ? [] : ["rotation"];
  if (!pool || !exactOptionalKeys(pool, POOL_KEYS, optionalKeys)) return null;
  if (!POOL_KEYS.slice(0, 5).every((key) => nonNegativeInteger(pool[key]))) return null;
  if ((pool.succeeded as number) > (pool.attempted as number)
    || (pool.cacheHits as number) + (pool.cacheMisses as number) > (pool.attempted as number)) return null;
  const generation = expected.requestedVersion === null
    ? null
    : rotationGeneration(pool.rotation);
  if (expected.requestedVersion !== null && generation === null) return null;
  const attestation = pool.attestation === null
    ? null
    : runtimeAttestation(pool.attestation, expected, executionProfile);
  if ((pool.attempted as number) === 0
    || pool.succeeded !== pool.attempted
    || (pool.cacheHits as number) + (pool.cacheMisses as number) !== pool.succeeded
    || attestation === null) return null;
  return {
    attempted: pool.attempted as number,
    succeeded: pool.succeeded as number,
    cacheHits: pool.cacheHits as number,
    cacheMisses: pool.cacheMisses as number,
    durationMs: pool.durationMs as number,
    generation,
    attestation,
  };
}

function sameRuntimeBase(left: RuntimeAttestation, right: RuntimeAttestation): boolean {
  return left.runtimeInstanceId === right.runtimeInstanceId
    && left.loadedRevision === right.loadedRevision
    && left.envProof === right.envProof
    && left.verifyJwt === right.verifyJwt
    && left.activationId === right.activationId;
}

export function validateEdgeRuntimePreheat(
  payload: unknown,
  expected: ExpectedEdgeRuntimePreheat,
): ValidatedEdgeRuntimePreheat | null {
  const response = objectRecord(payload);
  if (!response || !exactKeys(response, RESPONSE_KEYS)) return null;
  const expectedFunctionId = `${expected.projectRef}_${expected.functionSlug}${
    expected.resolvedVersion === null ? "" : `_v${expected.resolvedVersion}`
  }`;
  if (response.preheated !== expectedFunctionId
    || response.version !== expected.requestedVersion
    || response.success !== true) return null;
  const attestation = runtimeAttestation(response.attestation, expected, "foreground");
  const foreground = validatedPool(response.foreground, expected, "foreground");
  const background = validatedPool(response.background, expected, "background");
  if (!attestation || !foreground || !background) return null;
  if (!foreground.attestation || !background.attestation
    || !sameRuntimeBase(foreground.attestation, attestation)
    || !sameRuntimeBase(background.attestation, attestation)
    || foreground.attestation.moduleEnvProof !== attestation.moduleEnvProof
    || foreground.attestation.moduleEnvProof === background.attestation.moduleEnvProof) return null;
  const { attestation: _foregroundAttestation, ...safeForeground } = foreground;
  const { attestation: _backgroundAttestation, ...safeBackground } = background;
  return { identity: attestation, foreground: safeForeground, background: safeBackground };
}
