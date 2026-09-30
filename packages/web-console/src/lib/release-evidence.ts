import { requestValidatedJson } from "./validated-json";
import { validApplicationScope, type ApplicationScope } from "./application-dashboard";

/** Read-only console view of one immutable release target; not deployment evidence. */
export const releaseEvidenceSchema = "supacloud.release-evidence.v1";

export interface ReleaseEvidenceResponse {
  project_ref: string;
  application_id: string;
  release_id: string;
  schema: typeof releaseEvidenceSchema;
  correlation: "verified-build-snapshot";
  deploymentVerified: false;
  target: string;
  build: {
    producer: string; deploymentReady: false; manifestSha256: string; objectId: string;
    entryKind: string; entrypoint: string; files: number; bytes: number;
  };
  contract: {
    status: "present" | "absent"; schema: string | null; resources: number;
    diagnostics: { errors: number; warnings: number };
  };
  migrations: {
    status: "present" | "absent"; count: number; latestVersion: string | null;
    executionPerformed: false; compatibility: "not-proven"; dataRecovery: "separate-required";
  };
  rollback: { application: string; database: string; storage: string };
  notes: string[];
}

const targetPattern = /^[a-z][a-z0-9-]{0,62}$/;
function requireValue(valid: unknown): asserts valid {
  if (!valid) throw new Error("Invalid release evidence response");
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  const row = value as Record<string, unknown>;
  requireValue(Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key)));
  return row;
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}
function hash(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
}
function count(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
function validScope(scope: ApplicationScope): boolean {
  return [scope.ref, scope.application, scope.environment].every(value => typeof value === "string" && !/[\u0000-\u001f\u007f]/.test(value))
    && validApplicationScope(scope);
}
function validTarget(target: string): boolean {
  return typeof target === "string" && targetPattern.exec(target)?.[0] === target;
}
function version(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.exec(value)?.[0] === value
    && BigInt(value) <= 9_223_372_036_854_775_807n;
}

export function parseReleaseEvidence(
  value: unknown, scope: ApplicationScope, releaseId: string, target: string, expectedObjectId?: string,
): ReleaseEvidenceResponse {
  const row = record(value, ["project_ref", "application_id", "release_id", "schema", "correlation", "deploymentVerified",
    "target", "build", "contract", "migrations", "rollback", "notes"]);
  requireValue(validScope(scope) && hash(releaseId) && validTarget(target)
    && row.schema === releaseEvidenceSchema && row.correlation === "verified-build-snapshot"
    && row.deploymentVerified === false && row.project_ref === scope.ref && row.application_id === scope.application
    && row.release_id === releaseId && row.target === target);
  const build = record(row.build, ["producer", "deploymentReady", "manifestSha256", "objectId", "entryKind", "entrypoint", "files", "bytes"]);
  requireValue(build.producer === "@supacloud/compiler/delivery-build-v1" && build.deploymentReady === false
    && hash(build.manifestSha256) && hash(build.objectId)
    && typeof build.entryKind === "string"
    && ["bun-http-application", "bun-worker-application", "compiled-module-factory"].includes(build.entryKind)
    && build.entrypoint === "bundle/index.js" && count(build.files, 1024) && build.files > 0
    && count(build.bytes, 128 * 1024 * 1024)
    && (expectedObjectId === undefined || (hash(expectedObjectId) && build.objectId === expectedObjectId)));
  const contract = record(row.contract, ["status", "schema", "resources", "diagnostics"]);
  const diagnostics = record(contract.diagnostics, ["errors", "warnings"]);
  requireValue((contract.status === "present" || contract.status === "absent")
    && count(contract.resources, 64) && count(diagnostics.errors, 64) && count(diagnostics.warnings, 64)
    && diagnostics.errors + diagnostics.warnings <= 64);
  const contractPresent = contract.status === "present";
  requireValue(contractPresent ? contract.schema === "supacloud.application-development.v1"
    : contract.schema === null && contract.resources === 0 && diagnostics.errors === 0 && diagnostics.warnings === 0);
  const migrations = record(row.migrations, ["status", "count", "latestVersion", "executionPerformed", "compatibility", "dataRecovery"]);
  requireValue((migrations.status === "present" || migrations.status === "absent") && count(migrations.count, 128)
    && migrations.executionPerformed === false && migrations.compatibility === "not-proven"
    && migrations.dataRecovery === "separate-required");
  const migrationsPresent = migrations.status === "present";
  requireValue(migrationsPresent ? migrations.count > 0 && version(migrations.latestVersion)
    : migrations.count === 0 && migrations.latestVersion === null);
  const rollback = record(row.rollback, ["application", "database", "storage"]);
  requireValue(text(rollback.application) && text(rollback.database) && text(rollback.storage));
  requireValue(Array.isArray(row.notes) && row.notes.length <= 16 && row.notes.every(text));
  // Return only validated fields and fresh containers, never a cast of the raw response.
  return {
    project_ref: scope.ref, application_id: scope.application, release_id: releaseId,
    schema: releaseEvidenceSchema, correlation: "verified-build-snapshot", deploymentVerified: false, target,
    build: {
      producer: "@supacloud/compiler/delivery-build-v1", deploymentReady: false,
      manifestSha256: build.manifestSha256, objectId: build.objectId, entryKind: build.entryKind,
      entrypoint: "bundle/index.js", files: build.files, bytes: build.bytes,
    },
    contract: {
      status: contractPresent ? "present" : "absent", schema: contractPresent ? "supacloud.application-development.v1" : null,
      resources: contract.resources, diagnostics: { errors: diagnostics.errors, warnings: diagnostics.warnings },
    },
    migrations: {
      status: migrationsPresent ? "present" : "absent", count: migrations.count,
      latestVersion: migrationsPresent ? String(migrations.latestVersion) : null,
      executionPerformed: false, compatibility: "not-proven", dataRecovery: "separate-required",
    },
    rollback: { application: rollback.application, database: rollback.database, storage: rollback.storage },
    notes: row.notes.map(note => String(note)),
  };
}

type Request = (url: string, init: RequestInit) => Promise<Response>;
export function loadReleaseEvidence(
  scope: ApplicationScope, releaseId: string, target: string, request: Request, signal: AbortSignal,
  expectedObjectId?: string,
) {
  const selected = { ref: scope.ref, application: scope.application, environment: scope.environment };
  requireValue(validScope(selected) && hash(releaseId) && validTarget(target)
    && (expectedObjectId === undefined || hash(expectedObjectId)));
  const url = `/v1/projects/${encodeURIComponent(selected.ref)}/applications/${encodeURIComponent(selected.application)}`
    + `/releases/${encodeURIComponent(releaseId)}/evidence?target=${encodeURIComponent(target)}`;
  return requestValidatedJson(url, request,
    value => parseReleaseEvidence(value, selected, releaseId, target, expectedObjectId),
    { signal, cache: "no-store" }, { maxBytes: 256 * 1024 });
}
