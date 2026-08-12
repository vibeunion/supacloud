import { config } from "../config";
import { tenantRuntimeService } from "./tenant-runtime.service";
import { runtimeEnvService } from "./runtime-env.service";
import {
  ATTESTED_REVISION_PATTERN,
  edgeRuntimeEnvProof,
  runtimeEnvRevision,
} from "./runtime-revision";

const EDGE_OBSERVATION_SCHEMA = "supacloud.edge-runtime-env-observation.v1";
const RUNTIME_SNAPSHOT_SCHEMA = "supacloud.runtime-snapshot.v1";
const MAX_OBSERVATION_BYTES = 64 * 1024;
const OBSERVATION_KEYS = [
  "schema",
  "project_ref",
  "loaded_revision",
  "env_proof",
  "load_state",
  "load_source",
  "loaded_at",
] as const;
const LOAD_SOURCES = ["management_api", "stale_cache", "file_fallback"] as const;

type RuntimeEnvLoadSource = typeof LOAD_SOURCES[number];
type RuntimeEnvObservation = {
  schema: typeof EDGE_OBSERVATION_SCHEMA;
  project_ref: string;
  loaded_revision: string | null;
  env_proof: string | null;
  load_state: "loaded" | "unverified" | "not_loaded";
  load_source: RuntimeEnvLoadSource | null;
  loaded_at: string | null;
};

export interface RuntimeSecretsSnapshot {
  desired_revision: string;
  loaded_revision: string | null;
  load_state: "current" | "stale" | "not_loaded" | "unverified" | "unreachable";
  load_source: RuntimeEnvLoadSource | null;
  matches_desired: boolean | null;
  loaded_at: string | null;
}

export interface PublicRuntimeSnapshot {
  schema: typeof RUNTIME_SNAPSHOT_SCHEMA;
  project_ref: string;
  captured_at: string;
  secrets: RuntimeSecretsSnapshot;
  postgrest: {
    desired_revision: string;
    loaded_revision: string | null;
    attestation_state: "loaded" | "stale" | "drifted" | "unverified_legacy" | "stopped" | "unreachable";
    matches_desired: boolean | null;
    desired: "running" | "stopped";
    actual: "running" | "stopped" | "starting" | "error";
    health: "healthy" | "unhealthy" | "unknown";
    port: number;
    unit: string;
    loaded_at: string | null;
  };
}

type DesiredRuntimeEnv = {
  revision: string;
  proof: string;
};

function exactKeys(candidate: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(candidate).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expectedKeys[index]);
}

function isoTimestampOrNull(candidate: unknown): candidate is string | null {
  if (candidate === null) return true;
  if (typeof candidate !== "string") return false;
  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === candidate;
}

function revisionOrNull(candidate: unknown): candidate is string | null {
  return candidate === null
    || (typeof candidate === "string" && ATTESTED_REVISION_PATTERN.test(candidate));
}

function validObservationState(candidate: Record<string, unknown>): boolean {
  if (candidate.load_state === "loaded") {
    return candidate.loaded_revision !== null
      && candidate.env_proof !== null
      && candidate.load_source === "management_api"
      && typeof candidate.loaded_at === "string";
  }
  if (candidate.load_state === "unverified") {
    return candidate.loaded_revision === null
      && candidate.env_proof === null
      && candidate.load_source !== null
      && typeof candidate.loaded_at === "string";
  }
  return candidate.load_state === "not_loaded"
    && candidate.loaded_revision === null
    && candidate.env_proof === null
    && candidate.load_source === null
    && candidate.loaded_at === null;
}

function runtimeEnvObservation(payload: unknown, projectRef: string): RuntimeEnvObservation | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const candidate = payload as Record<string, unknown>;
  if (!exactKeys(candidate, OBSERVATION_KEYS)
    || candidate.schema !== EDGE_OBSERVATION_SCHEMA
    || candidate.project_ref !== projectRef
    || !revisionOrNull(candidate.loaded_revision)
    || !revisionOrNull(candidate.env_proof)
    || !["loaded", "unverified", "not_loaded"].includes(candidate.load_state as string)
    || !(candidate.load_source === null || LOAD_SOURCES.includes(candidate.load_source as RuntimeEnvLoadSource))
    || !isoTimestampOrNull(candidate.loaded_at)
    || !validObservationState(candidate)) {
    return null;
  }
  return candidate as RuntimeEnvObservation;
}

async function boundedResponseBytes(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length") || "0");
  if (declaredLength > MAX_OBSERVATION_BYTES) {
    throw new Error("Observation response is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > MAX_OBSERVATION_BYTES) {
        await reader.cancel();
        throw new Error("Observation response is too large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function boundedJson(response: Response): Promise<unknown> {
  const bytes = await boundedResponseBytes(response);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text);
}

export async function fetchRuntimeEnvObservation(
  projectRef: string,
  fetcher: typeof fetch = fetch,
): Promise<RuntimeEnvObservation | null> {
  try {
    const response = await fetcher(
      `http://${config.edgeRuntimeInternal}/internal/runtime-env-observation/${encodeURIComponent(projectRef)}`,
      {
        headers: {
          "x-supacloud-internal-auth": config.edgeRuntimeMasterKey || config.masterToken,
        },
        redirect: "error",
        signal: AbortSignal.timeout(1_000),
      },
    );
    if (!response.ok) return null;
    return runtimeEnvObservation(await boundedJson(response), projectRef);
  } catch {
    return null;
  }
}

async function readDesiredRuntimeEnv(projectRef: string): Promise<DesiredRuntimeEnv> {
  const env = await runtimeEnvService.buildProjectRuntimeEnv(projectRef);
  if (!env) throw new Error(`Authoritative runtime environment is unavailable for ${projectRef}`);
  return {
    revision: runtimeEnvRevision(projectRef, env),
    proof: edgeRuntimeEnvProof(projectRef, env),
  };
}

async function stableDesiredRuntimeEnv(projectRef: string): Promise<DesiredRuntimeEnv> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await readDesiredRuntimeEnv(projectRef);
    const after = await readDesiredRuntimeEnv(projectRef);
    if (before.revision === after.revision && before.proof === after.proof) return after;
  }
  throw new Error(`Authoritative runtime environment is unstable for ${projectRef}`);
}

function secretsSnapshot(
  desired: DesiredRuntimeEnv,
  observation: RuntimeEnvObservation | null,
): RuntimeSecretsSnapshot {
  if (!observation) {
    return {
      desired_revision: desired.revision,
      loaded_revision: null,
      load_state: "unreachable",
      load_source: null,
      matches_desired: null,
      loaded_at: null,
    };
  }
  if (observation.load_state !== "loaded") {
    return {
      desired_revision: desired.revision,
      loaded_revision: null,
      load_state: observation.load_state,
      load_source: observation.load_source,
      matches_desired: null,
      loaded_at: observation.loaded_at,
    };
  }
  const revisionMatches = observation.loaded_revision === desired.revision;
  const proofMatches = observation.env_proof === desired.proof;
  return {
    desired_revision: desired.revision,
    loaded_revision: observation.loaded_revision,
    load_state: revisionMatches && proofMatches
      ? "current"
      : (revisionMatches ? "unverified" : "stale"),
    load_source: observation.load_source,
    matches_desired: revisionMatches ? (proofMatches ? true : null) : false,
    loaded_at: observation.loaded_at,
  };
}

export async function buildPublicRuntimeSnapshot(projectRef: string): Promise<PublicRuntimeSnapshot> {
  const [desiredEnv, postgrest] = await Promise.all([
    stableDesiredRuntimeEnv(projectRef),
    tenantRuntimeService.runtimeSnapshotPostgrest(projectRef),
  ]);
  const observation = await fetchRuntimeEnvObservation(projectRef);
  return {
    schema: RUNTIME_SNAPSHOT_SCHEMA,
    project_ref: projectRef,
    captured_at: new Date().toISOString(),
    secrets: secretsSnapshot(desiredEnv, observation),
    postgrest: {
      desired_revision: postgrest.desiredRevision,
      loaded_revision: postgrest.loadedRevision,
      attestation_state: postgrest.attestationState,
      matches_desired: postgrest.matchesDesired,
      desired: postgrest.desired,
      actual: postgrest.actual,
      health: postgrest.health,
      port: postgrest.port,
      unit: postgrest.unit,
      loaded_at: postgrest.loadedAt,
    },
  };
}

export const runtimeSnapshotService = {
  buildPublicRuntimeSnapshot,
};

export const runtimeSnapshotServiceInternals = {
  fetchRuntimeEnvObservation,
  runtimeEnvObservation,
  secretsSnapshot,
};
