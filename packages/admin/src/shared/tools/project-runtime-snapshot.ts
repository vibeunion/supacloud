const RUNTIME_SNAPSHOT_SCHEMA = "supacloud.runtime-snapshot.v1";
const ATTESTED_REVISION_PATTERN = /^hmac-sha256:[a-f0-9]{64}$/;
const SAFE_PROJECT_REF = /^[a-z0-9-]{1,20}$/;
const SNAPSHOT_KEYS = ["schema", "project_ref", "captured_at", "secrets", "postgrest"] as const;
const SECRETS_KEYS = [
    "desired_revision", "loaded_revision", "load_state", "load_source", "matches_desired", "loaded_at",
] as const;
const POSTGREST_KEYS = [
    "desired_revision", "loaded_revision", "attestation_state", "matches_desired", "desired", "actual",
    "health", "port", "unit", "loaded_at",
] as const;
const SECRET_LOAD_STATES = ["current", "stale", "not_loaded", "unverified", "unreachable"] as const;
const SECRET_LOAD_SOURCES = ["management_api", "stale_cache", "file_fallback"] as const;
const POSTGREST_ATTESTATION_STATES = [
    "loaded", "stale", "drifted", "unverified_legacy", "stopped", "unreachable",
] as const;
const POSTGREST_DESIRED_STATES = ["running", "stopped"] as const;
const POSTGREST_ACTUAL_STATES = ["running", "stopped", "starting", "error"] as const;
const POSTGREST_HEALTH_STATES = ["healthy", "unhealthy", "unknown"] as const;

type SecretLoadState = typeof SECRET_LOAD_STATES[number];
type SecretLoadSource = typeof SECRET_LOAD_SOURCES[number];
type PostgrestAttestationState = typeof POSTGREST_ATTESTATION_STATES[number];
type PostgrestDesiredState = typeof POSTGREST_DESIRED_STATES[number];
type PostgrestActualState = typeof POSTGREST_ACTUAL_STATES[number];
type PostgrestHealthState = typeof POSTGREST_HEALTH_STATES[number];

interface RuntimeSecretsSnapshot {
    desired_revision: string;
    loaded_revision: string | null;
    load_state: SecretLoadState;
    load_source: SecretLoadSource | null;
    matches_desired: boolean | null;
    loaded_at: string | null;
}

interface PostgrestRuntimeSnapshot {
    desired_revision: string;
    loaded_revision: string | null;
    attestation_state: PostgrestAttestationState;
    matches_desired: boolean | null;
    desired: PostgrestDesiredState;
    actual: PostgrestActualState;
    health: PostgrestHealthState;
    port: number;
    unit: string;
    loaded_at: string | null;
}

export interface ProjectRuntimeSnapshot {
    schema: typeof RUNTIME_SNAPSHOT_SCHEMA;
    project_ref: string;
    captured_at: string;
    secrets: RuntimeSecretsSnapshot;
    postgrest: PostgrestRuntimeSnapshot;
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
    return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}

function hasExactKeys(candidate: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
    const actualKeys = Object.keys(candidate).sort();
    const sortedExpectedKeys = [...expectedKeys].sort();
    return actualKeys.length === sortedExpectedKeys.length
        && actualKeys.every((key, index) => key === sortedExpectedKeys[index]);
}

function isEnumMember<T extends string>(candidate: unknown, members: readonly T[]): candidate is T {
    return typeof candidate === "string" && members.includes(candidate as T);
}

function isIsoTimestampOrNull(candidate: unknown): candidate is string | null {
    if (candidate === null) return true;
    if (typeof candidate !== "string") return false;
    const timestamp = Date.parse(candidate);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === candidate;
}

function isRevisionOrNull(candidate: unknown): candidate is string | null {
    return candidate === null
        || (typeof candidate === "string" && ATTESTED_REVISION_PATTERN.test(candidate));
}

function isBooleanOrNull(candidate: unknown): candidate is boolean | null {
    return candidate === null || typeof candidate === "boolean";
}

function isUnloadedSecretsState(candidate: RuntimeSecretsSnapshot): boolean {
    return candidate.loaded_revision === null
        && candidate.load_source === null
        && candidate.matches_desired === null
        && candidate.loaded_at === null;
}

function isLoadedSecretsState(candidate: RuntimeSecretsSnapshot): boolean {
    if (candidate.load_state === "current") {
        return candidate.loaded_revision === candidate.desired_revision
            && candidate.load_source === "management_api"
            && candidate.matches_desired === true
            && candidate.loaded_at !== null;
    }
    return candidate.load_state === "stale"
        && candidate.loaded_revision !== null
        && candidate.loaded_revision !== candidate.desired_revision
        && candidate.load_source === "management_api"
        && candidate.matches_desired === false
        && candidate.loaded_at !== null;
}

function isUnverifiedSecretsState(candidate: RuntimeSecretsSnapshot): boolean {
    if (candidate.load_state !== "unverified" || candidate.matches_desired !== null
        || candidate.loaded_at === null) return false;
    if (candidate.loaded_revision === candidate.desired_revision) {
        return candidate.load_source === "management_api";
    }
    return candidate.loaded_revision === null && candidate.load_source !== null;
}

function hasValidSecretsState(candidate: RuntimeSecretsSnapshot): boolean {
    if (candidate.load_state === "not_loaded" || candidate.load_state === "unreachable") {
        return isUnloadedSecretsState(candidate);
    }
    return isLoadedSecretsState(candidate) || isUnverifiedSecretsState(candidate);
}

function isRuntimeSecretsSnapshot(payload: unknown): payload is RuntimeSecretsSnapshot {
    if (!isRecord(payload) || !hasExactKeys(payload, SECRETS_KEYS)) return false;
    if (!isRevisionOrNull(payload.loaded_revision)
        || typeof payload.desired_revision !== "string"
        || !ATTESTED_REVISION_PATTERN.test(payload.desired_revision)
        || !isEnumMember(payload.load_state, SECRET_LOAD_STATES)
        || !(payload.load_source === null || isEnumMember(payload.load_source, SECRET_LOAD_SOURCES))
        || !isBooleanOrNull(payload.matches_desired)
        || !isIsoTimestampOrNull(payload.loaded_at)) return false;
    return hasValidSecretsState(payload as unknown as RuntimeSecretsSnapshot);
}

function hasConsistentRevisionMatch(candidate: PostgrestRuntimeSnapshot): boolean {
    if (candidate.loaded_revision === null) return candidate.matches_desired === null;
    return candidate.matches_desired === (candidate.loaded_revision === candidate.desired_revision);
}

function hasActivePostgrestProjection(candidate: PostgrestRuntimeSnapshot): boolean {
    return (candidate.actual === "running" && candidate.health === "healthy")
        || (candidate.actual === "error" && candidate.health === "unhealthy");
}

function hasValidPostgrestState(candidate: PostgrestRuntimeSnapshot): boolean {
    if (!hasConsistentRevisionMatch(candidate)) return false;
    if (candidate.attestation_state === "loaded") {
        return candidate.matches_desired === true
            && candidate.actual === "running"
            && candidate.health === "healthy"
            && candidate.loaded_at !== null;
    }
    if (candidate.attestation_state === "stale") {
        return candidate.loaded_revision !== null
            && candidate.matches_desired === false
            && candidate.loaded_at !== null
            && hasActivePostgrestProjection(candidate);
    }
    if (candidate.attestation_state === "unverified_legacy") return candidate.loaded_revision === null;
    if (candidate.attestation_state === "stopped") {
        return candidate.loaded_revision === null
            && candidate.actual === "stopped"
            && candidate.health === "unknown"
            && candidate.loaded_at === null;
    }
    if (candidate.attestation_state === "unreachable") return candidate.loaded_revision === null;
    return candidate.attestation_state === "drifted";
}

function isPostgrestRuntimeSnapshot(payload: unknown, projectRef: string): payload is PostgrestRuntimeSnapshot {
    if (!isRecord(payload) || !hasExactKeys(payload, POSTGREST_KEYS)) return false;
    if (typeof payload.desired_revision !== "string"
        || !ATTESTED_REVISION_PATTERN.test(payload.desired_revision)
        || !isRevisionOrNull(payload.loaded_revision)
        || !isEnumMember(payload.attestation_state, POSTGREST_ATTESTATION_STATES)
        || !isBooleanOrNull(payload.matches_desired)
        || !isEnumMember(payload.desired, POSTGREST_DESIRED_STATES)
        || !isEnumMember(payload.actual, POSTGREST_ACTUAL_STATES)
        || !isEnumMember(payload.health, POSTGREST_HEALTH_STATES)
        || !Number.isSafeInteger(payload.port) || Number(payload.port) < 1 || Number(payload.port) > 65_535
        || payload.unit !== `supacloud-pgrst@${projectRef}`
        || !isIsoTimestampOrNull(payload.loaded_at)) return false;
    return hasValidPostgrestState(payload as unknown as PostgrestRuntimeSnapshot);
}

function sanitizedSnapshot(snapshot: ProjectRuntimeSnapshot): ProjectRuntimeSnapshot {
    return {
        schema: snapshot.schema,
        project_ref: snapshot.project_ref,
        captured_at: snapshot.captured_at,
        secrets: { ...snapshot.secrets },
        postgrest: { ...snapshot.postgrest },
    };
}

function hasCausalLoadTimestamps(snapshot: ProjectRuntimeSnapshot): boolean {
    const capturedAt = Date.parse(snapshot.captured_at);
    return [snapshot.secrets.loaded_at, snapshot.postgrest.loaded_at]
        .every((loadedAt) => loadedAt === null || Date.parse(loadedAt) <= capturedAt);
}

export function parseProjectRuntimeSnapshot(
    payload: unknown,
    requestedProjectRef: string,
): ProjectRuntimeSnapshot | null {
    if (!SAFE_PROJECT_REF.test(requestedProjectRef)
        || !isRecord(payload)
        || !hasExactKeys(payload, SNAPSHOT_KEYS)
        || payload.schema !== RUNTIME_SNAPSHOT_SCHEMA
        || payload.project_ref !== requestedProjectRef
        || !isIsoTimestampOrNull(payload.captured_at) || payload.captured_at === null
        || !isRuntimeSecretsSnapshot(payload.secrets)
        || !isPostgrestRuntimeSnapshot(payload.postgrest, requestedProjectRef)) return null;
    const snapshot = payload as unknown as ProjectRuntimeSnapshot;
    return hasCausalLoadTimestamps(snapshot) ? sanitizedSnapshot(snapshot) : null;
}
