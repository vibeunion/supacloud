import { requestValidatedJson } from "./validated-json";
import { validApplicationScope, type ApplicationScope } from "./application-dashboard";

/** Read-only console view of `supacloud.release-evidence.v1` for one release target. */
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

const id = /^[A-Za-z0-9_-]{1,64}$/;
const hash = /^[a-f0-9]{64}$/;
const targetPattern = /^[a-z][a-z0-9-]{0,62}$/;
function requireValue(valid: unknown): asserts valid {
  if (!valid) throw new Error("Invalid release evidence response");
}
function record(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}
function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function parseReleaseEvidence(
  value: unknown, scope: ApplicationScope, releaseId: string, target: string,
): ReleaseEvidenceResponse {
  const row = record(value);
  requireValue(validApplicationScope(scope) && hash.test(releaseId) && targetPattern.test(target)
    && row.schema === releaseEvidenceSchema && row.correlation === "verified-build-snapshot"
    && row.deploymentVerified === false && row.project_ref === scope.ref && row.application_id === scope.application
    && row.release_id === releaseId && row.target === target);
  const build = record(row.build);
  requireValue(text(build.producer) && build.deploymentReady === false && text(build.manifestSha256) && hash.test(build.manifestSha256)
    && hash.test(String(build.objectId)) && text(build.entryKind) && text(build.entrypoint)
    && count(build.files) && count(build.bytes));
  const contract = record(row.contract);
  requireValue((contract.status === "present" || contract.status === "absent")
    && (contract.status === "present" ? text(contract.schema) : contract.schema === null)
    && count(contract.resources) && count(record(contract.diagnostics).errors) && count(record(contract.diagnostics).warnings));
  const migrations = record(row.migrations);
  requireValue((migrations.status === "present" || migrations.status === "absent")
    && count(migrations.count)
    && (migrations.status === "present" ? text(migrations.latestVersion) : migrations.latestVersion === null)
    && migrations.executionPerformed === false && migrations.compatibility === "not-proven"
    && migrations.dataRecovery === "separate-required");
  const rollback = record(row.rollback);
  requireValue(text(rollback.application) && text(rollback.database) && text(rollback.storage));
  requireValue(Array.isArray(row.notes) && row.notes.length <= 16 && row.notes.every(text));
  return row as unknown as ReleaseEvidenceResponse;
}

type Request = (url: string, init: RequestInit) => Promise<Response>;
export function loadReleaseEvidence(
  scope: ApplicationScope, releaseId: string, target: string, request: Request, signal: AbortSignal,
) {
  requireValue(validApplicationScope(scope) && hash.test(releaseId) && targetPattern.test(target));
  const url = `/v1/projects/${encodeURIComponent(scope.ref)}/applications/${encodeURIComponent(scope.application)}`
    + `/releases/${encodeURIComponent(releaseId)}/evidence?target=${encodeURIComponent(target)}`;
  return requestValidatedJson(url, request,
    value => parseReleaseEvidence(value, scope, releaseId, target),
    { signal, cache: "no-store" }, { maxBytes: 256 * 1024 });
}