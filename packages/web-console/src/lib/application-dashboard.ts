import { requestValidatedJson } from "./validated-json";

export interface ApplicationScope { ref: string; application: string; environment: string }
export const readinessCodes = [
  "READY", "PROCESS_NOT_RUNNING", "PROCESS_CHANGED", "SUPERVISOR_UNAVAILABLE",
  "HTTP_NOT_READY", "IDENTITY_MISMATCH", "WORKER_NOT_READY", "PROBE_UNAVAILABLE",
] as const;
export interface RuntimeTarget {
  target: string; kind: "http" | "worker"; unit: string; pid: number;
  invocation_id: string | null; ready: boolean; code: typeof readinessCodes[number];
}
export interface RuntimeResponse {
  project_ref: string; application_id: string; environment_id: string;
  configuration_id?: string;
  readiness: null | {
    project_ref: string; application_id: string; environment_id: string;
    release_id: string; activation_id: string; ready: boolean; targets: RuntimeTarget[];
  };
}
export interface Release {
  schema: "supacloud.application-release.v1";
  project_ref: string; application_id: string; release_id: string;
  manifest_sha256: string; created_at: string;
  targets: { name: string; object_id: string; kind: "http" | "worker"; entrypoint: "bundle/index.js" }[];
}
export interface ReleasePage {
  project_ref: string; application_id: string; releases: Release[]; next_cursor: string | null;
}
const id = /^[A-Za-z0-9_-]{1,64}$/;
const hash = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const targetName = /^[a-z][a-z0-9-]{0,62}$/;
function requireValue(valid: unknown): asserts valid {
  if (!valid) throw new Error("Invalid application dashboard response");
}
function record(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}
export function validApplicationScope(scope: ApplicationScope): boolean {
  return /^[a-z0-9-]{1,20}$/.test(scope.ref) && id.test(scope.application) && id.test(scope.environment);
}
function identity(value: Record<string, unknown>, scope: ApplicationScope, environment = false) {
  requireValue(validApplicationScope(scope) && value.project_ref === scope.ref
    && value.application_id === scope.application && (!environment || value.environment_id === scope.environment));
}
function targets(value: unknown, name: string): Record<string, unknown>[] {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= 32);
  const rows = value.map(record);
  requireValue(rows.every(row => matches(row[name], targetName) && ["http", "worker"].includes(String(row.kind)))
    && new Set(rows.map(row => row[name])).size === rows.length);
  return rows;
}
export class ApplicationRuntimeChanged extends Error {}
export function parseApplicationRuntime(value: unknown, scope: ApplicationScope): RuntimeResponse {
  const row = record(value);
  identity(row, scope, true);
  requireValue(row.configuration_id === undefined || matches(row.configuration_id, uuid));
  if (row.readiness !== null) {
    const report = record(row.readiness);
    identity(report, scope, true);
    requireValue(matches(report.release_id, hash) && matches(report.activation_id, uuid));
    const rows = targets(report.targets, "target");
    for (const target of rows) {
      requireValue(typeof target.ready === "boolean" && readinessCodes.some(code => code === target.code)
        && target.ready === (target.code === "READY")
        && Number.isSafeInteger(target.pid) && Number(target.pid) >= 0
        && (target.invocation_id === null || matches(target.invocation_id, /^[a-f0-9]{32}$/))
        && (!target.ready || (Number(target.pid) > 0 && target.invocation_id !== null))
        && target.unit === `supacloud-application-${scope.ref}-${report.activation_id}-${target.target}.service`);
    }
    requireValue(typeof report.ready === "boolean" && report.ready === rows.every(target => target.ready));
  }
  return row as unknown as RuntimeResponse;
}
export function parseApplicationReleases(value: unknown, scope: ApplicationScope, cursor?: string): ReleasePage {
  const row = record(value);
  identity(row, scope);
  requireValue(Array.isArray(row.releases) && row.releases.length <= 50);
  let previous = cursor ?? "";
  for (const entry of row.releases) {
    const release = record(entry);
    identity(release, scope);
    requireValue(release.schema === "supacloud.application-release.v1"
      && matches(release.release_id, hash) && release.release_id > previous
      && matches(release.manifest_sha256, hash)
      && typeof release.created_at === "string" && Number.isFinite(Date.parse(release.created_at))
      && new Date(release.created_at).toISOString() === release.created_at);
    previous = release.release_id;
    requireValue(targets(release.targets, "name").every(target =>
      matches(target.object_id, hash) && target.entrypoint === "bundle/index.js"));
  }
  requireValue(row.next_cursor === null || (matches(row.next_cursor, hash)
    && row.releases.length > 0 && row.next_cursor === previous));
  return row as unknown as ReleasePage;
}
type Request = (url: string, init: RequestInit) => Promise<Response>;
function base(scope: ApplicationScope) {
  requireValue(validApplicationScope(scope));
  return `/v1/projects/${encodeURIComponent(scope.ref)}/applications/${encodeURIComponent(scope.application)}`;
}
export function loadApplicationRuntime(scope: ApplicationScope, request: Request, signal: AbortSignal) {
  return requestValidatedJson(`${base(scope)}/environments/${encodeURIComponent(scope.environment)}/runtime`,
    request, (value, status) => {
      if (status === 409) {
        requireValue(record(value).code === "APPLICATION_RUNTIME_CHANGED");
        throw new ApplicationRuntimeChanged();
      }
      return parseApplicationRuntime(value, scope);
    }, { signal, cache: "no-store" }, { statuses: [200, 409], maxBytes: 64 * 1024 });
}
export function loadApplicationReleases(scope: ApplicationScope, request: Request, signal: AbortSignal, cursor?: string) {
  requireValue(cursor === undefined || matches(cursor, hash));
  return requestValidatedJson(`${base(scope)}/releases?limit=50${cursor ? `&cursor=${cursor}` : ""}`,
    request, value => parseApplicationReleases(value, scope, cursor),
    { signal, cache: "no-store" }, { maxBytes: 1024 * 1024 });
}
