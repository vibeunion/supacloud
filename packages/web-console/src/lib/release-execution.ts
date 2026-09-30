import { requestValidatedJson } from "./validated-json";
import { validApplicationScope, type ApplicationScope } from "./application-dashboard";

/** Read-only console view of one recorded release execution; never deployment evidence by itself. */
export const releaseExecutionSchema = "supacloud.release-execution.v1";

export type ReleaseExecutionComponentName =
  | "application" | "migrations" | "configuration" | "resources" | "secrets" | "health";
export type ReleaseExecutionStatus = "succeeded" | "failed" | "unknown";

export interface ReleaseExecutionComponentResult {
  name: ReleaseExecutionComponentName;
  status: ReleaseExecutionStatus;
  required: boolean;
  version: string | null;
  detail: string | null;
  observedAt: string | null;
}

export interface ReleaseExecutionResponse {
  project_ref: string;
  application_id: string;
  release_id: string;
  schema: typeof releaseExecutionSchema;
  correlation: "release-execution-observation";
  target: string;
  manifestSha256: string;
  deploymentVerified: boolean;
  components: ReleaseExecutionComponentResult[];
  recovery: { application: string; database: string; storage: string };
  notes: string[];
}

const componentNames: readonly ReleaseExecutionComponentName[] = [
  "application", "migrations", "configuration", "resources", "secrets", "health",
];
const requiredComponents: readonly ReleaseExecutionComponentName[] = ["application", "migrations", "health"];
const statuses: readonly ReleaseExecutionStatus[] = ["succeeded", "failed", "unknown"];
const targetPattern = /^[a-z][a-z0-9-]{0,62}$/;

function requireValue(valid: unknown): asserts valid {
  if (!valid) throw new Error("Invalid release execution response");
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
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function validScope(scope: ApplicationScope): boolean {
  return [scope.ref, scope.application, scope.environment].every(value => typeof value === "string" && !/[\u0000-\u001f\u007f]/.test(value))
    && validApplicationScope(scope);
}
function validTarget(target: string): boolean {
  return typeof target === "string" && targetPattern.exec(target)?.[0] === target;
}
function status(value: unknown): value is ReleaseExecutionStatus {
  return typeof value === "string" && (statuses as readonly string[]).includes(value);
}
function optionalText(value: unknown): value is string | null {
  return value === null || text(value);
}
function timestamp(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value)));
}

export function parseReleaseExecution(
  value: unknown, scope: ApplicationScope, releaseId: string, target: string,
): ReleaseExecutionResponse {
  const row = record(value, ["project_ref", "application_id", "release_id", "schema", "correlation", "target",
    "manifestSha256", "deploymentVerified", "components", "recovery", "notes"]);
  requireValue(validScope(scope) && hash(releaseId) && validTarget(target)
    && row.schema === releaseExecutionSchema && row.correlation === "release-execution-observation"
    && row.project_ref === scope.ref && row.application_id === scope.application
    && row.release_id === releaseId && row.target === target && hash(row.manifestSha256)
    && typeof row.deploymentVerified === "boolean"
    && Array.isArray(row.components) && row.components.length === componentNames.length);

  const components = componentNames.map((name, index) => {
    const component = record((row.components as unknown[])[index],
      ["name", "status", "required", "version", "detail", "observedAt"]);
    requireValue(component.name === name && status(component.status) && component.required === requiredComponents.includes(name)
      && optionalText(component.version) && optionalText(component.detail) && timestamp(component.observedAt));
    requireValue(component.status === "unknown"
      ? component.version === null && component.detail === null
      : component.observedAt !== null);
    return {
      name, status: component.status as ReleaseExecutionStatus, required: component.required,
      version: component.version as string | null, detail: component.detail as string | null,
      observedAt: component.observedAt as string | null,
    };
  });

  const verified = components.every(component => component.status !== "failed")
    && components.filter(component => component.required).every(component => component.status === "succeeded");
  requireValue(row.deploymentVerified === verified);

  const recovery = record(row.recovery, ["application", "database", "storage"]);
  requireValue(text(recovery.application) && text(recovery.database) && text(recovery.storage));
  requireValue(Array.isArray(row.notes) && row.notes.length <= 16 && row.notes.every(text));

  // Return only validated fields and fresh containers, never a cast of the raw response.
  return {
    project_ref: scope.ref, application_id: scope.application, release_id: releaseId,
    schema: releaseExecutionSchema, correlation: "release-execution-observation", target,
    manifestSha256: row.manifestSha256, deploymentVerified: verified, components,
    recovery: {
      application: recovery.application, database: recovery.database, storage: recovery.storage,
    },
    notes: row.notes.map(note => String(note)),
  };
}

type Request = (url: string, init: RequestInit) => Promise<Response>;
export function loadReleaseExecution(
  scope: ApplicationScope, releaseId: string, target: string, request: Request, signal: AbortSignal,
) {
  const selected = { ref: scope.ref, application: scope.application, environment: scope.environment };
  requireValue(validScope(selected) && hash(releaseId) && validTarget(target));
  const url = `/v1/projects/${encodeURIComponent(selected.ref)}/applications/${encodeURIComponent(selected.application)}`
    + `/releases/${encodeURIComponent(releaseId)}/execution?target=${encodeURIComponent(target)}`;
  return requestValidatedJson(url, request,
    value => parseReleaseExecution(value, selected, releaseId, target),
    { signal, cache: "no-store" }, { maxBytes: 256 * 1024 });
}