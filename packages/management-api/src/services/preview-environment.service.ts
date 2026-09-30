import { createHash } from "node:crypto";
import { AppError } from "../utils/errors";

/** A bounded plan, not provisioning, authorization or proof of isolation. */
export const PREVIEW_ENVIRONMENT_SCHEMA = "supacloud.preview-environment.v1";
export type PreviewEnvironmentErrorCode =
  | "PREVIEW_ENVIRONMENT_INVALID"
  | "PREVIEW_ENVIRONMENT_PRODUCTION_FORBIDDEN"
  | "PREVIEW_ENVIRONMENT_FULL_CLONE_REQUIRES_AUTHORIZATION"
  | "PREVIEW_ENVIRONMENT_INLINE_SECRET_FORBIDDEN";
export class PreviewEnvironmentError extends AppError {
  constructor(readonly previewCode: PreviewEnvironmentErrorCode) {
    super(previewCode, previewCode === "PREVIEW_ENVIRONMENT_INVALID" ? 422 : 403, previewCode);
    this.name = "PreviewEnvironmentError";
  }
}
export type PreviewComponentName =
  | "database" | "application" | "configuration" | "resources" | "queues" | "storage" | "secrets";
export type PreviewComponentStatus = "planned" | "ready" | "failed" | "unknown";
export interface PreviewEnvironmentComponent {
  name: PreviewComponentName;
  status: PreviewComponentStatus;
  detail: string;
}
export type PreviewIsolationCheckKey =
  | "database_role" | "storage_permissions" | "consumer_identity" | "route_access_control";
export interface PreviewEnvironmentIsolationCheck {
  key: PreviewIsolationCheckKey;
  status: "pending" | "verified" | "failed";
  requirement: string;
}
export interface PreviewEnvironmentLifecycle {
  reclaim_on: "pr_closed" | "timeout";
  timeout_hours: number;
  residue: "delete_branch_and_namespace";
}
export interface PreviewEnvironment {
  schema: typeof PREVIEW_ENVIRONMENT_SCHEMA;
  preview_ref: string;
  project_ref: string;
  application_id: string;
  environment_id: string;
  release_id: string;
  source: { branch: string; commit: string };
  data_mode: "schema_only" | "full_clone";
  branch_ref: string;
  /** Retain structured references; component detail strings are display-only. */
  configuration_id: string | null;
  resource_bindings: Record<string, string>;
  lifecycle: PreviewEnvironmentLifecycle;
  components: PreviewEnvironmentComponent[];
  isolation: PreviewEnvironmentIsolationCheck[];
  production_blocked: true;
  notes: string[];
}
export interface PreviewComposeInput {
  previewRef: string;
  projectRef: string;
  applicationId: string;
  environmentId: string;
  releaseId: string;
  source: { branch: string; commit: string };
  configurationId?: string;
  resources?: Readonly<Record<string, string>>;
  dataMode?: "schema_only" | "full_clone";
  /** Trusted internal policy result. HTTP callers cannot grant this permission. */
  authorizedFullClone?: boolean;
  lifecycle?: { reclaimOn?: "pr_closed" | "timeout"; timeoutHours?: number };
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const PRODUCTION_SHAPE = /^(?:prod|production|live|release)(?:[-_]|$)/i;
const REFERENCE = /^[a-z][a-z0-9-]{0,15}:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TIMEOUT_HOURS = 720;
const MAX_RESOURCES = 64;
const MAX_OUTPUT_BYTES = 65_536;
const ISOLATION_REQUIREMENTS: ReadonlyArray<{ key: PreviewIsolationCheckKey; requirement: string }> = [
  { key: "database_role", requirement: "The preview database role must not hold cluster-management privileges." },
  { key: "storage_permissions", requirement: "Storage access must be scoped to the preview project binding, not the parent." },
  { key: "consumer_identity", requirement: "Queue consumers must run under a preview-scoped identity." },
  { key: "route_access_control", requirement: "Preview routes must reject production credentials and must not be publicly indexed." },
];
function invalid(): never { throw new PreviewEnvironmentError("PREVIEW_ENVIRONMENT_INVALID"); }
function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && !CONTROL.test(value) && pattern.exec(value)?.[0] === value;
}
function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === null || proto === Object.prototype)
    && Reflect.ownKeys(value).every(key => typeof key === "string"
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"));
}
function assertProductionSafe(value: string): void {
  if (value.split(/[/:.]/).some(part => PRODUCTION_SHAPE.test(part))) {
    throw new PreviewEnvironmentError("PREVIEW_ENVIRONMENT_PRODUCTION_FORBIDDEN");
  }
}

/** Includes exact project identity; no lossy case folding or truncation of source IDs. */
export function derivePreviewBranchRef(projectRef: string, previewRef: string): string {
  if (!matches(projectRef, /^[A-Za-z0-9_-]{1,20}$/)
    || !matches(previewRef, /^[A-Za-z0-9_-]{1,32}$/)) invalid();
  return "pv" + createHash("sha256").update(JSON.stringify(["supacloud-preview-v1", projectRef, previewRef])).digest("hex").slice(0, 18);
}

/** Plan only; execution must independently verify ownership, non-production and masked-data policy. */
export function composePreviewEnvironment(input: PreviewComposeInput): PreviewEnvironment {
  if (!record(input) || !record(input.source)
    || !matches(input.previewRef, /^[A-Za-z0-9_-]{1,32}$/)
    || !matches(input.projectRef, /^[A-Za-z0-9_-]{1,20}$/)
    || !matches(input.applicationId, IDENTIFIER) || !matches(input.environmentId, IDENTIFIER)
    || !matches(input.releaseId, /^[a-f0-9]{64}$/)
    || typeof input.source.branch !== "string" || input.source.branch.trim().length === 0
    || input.source.branch.length > 255 || CONTROL.test(input.source.branch)
    || /\s|:\/\//.test(input.source.branch) || input.source.branch.includes("..")
    || !matches(input.source.commit, /^(?:[a-f0-9]{7,40})?$/)
    || (input.configurationId !== undefined && !matches(input.configurationId, UUID))
    || (input.authorizedFullClone !== undefined && typeof input.authorizedFullClone !== "boolean")
    || (input.resources !== undefined && !record(input.resources))
    || (input.lifecycle !== undefined && !record(input.lifecycle))) invalid();
  assertProductionSafe(input.environmentId);
  assertProductionSafe(input.source.branch);
  const dataMode = input.dataMode ?? "schema_only";
  if (dataMode !== "schema_only" && dataMode !== "full_clone") invalid();
  if (dataMode === "full_clone" && input.authorizedFullClone !== true) {
    throw new PreviewEnvironmentError("PREVIEW_ENVIRONMENT_FULL_CLONE_REQUIRES_AUTHORIZATION");
  }
  const resources = Object.entries(input.resources ?? {}).sort(([a], [b]) => a.localeCompare(b, "en"));
  if (resources.length > MAX_RESOURCES) invalid();
  for (const [name, binding] of resources) {
    if (!name.trim() || name.length > 512 || CONTROL.test(name)) invalid();
    if (!matches(binding, REFERENCE)) {
      throw new PreviewEnvironmentError(typeof binding === "string" && /:\/\/|@|=/.test(binding)
        ? "PREVIEW_ENVIRONMENT_INLINE_SECRET_FORBIDDEN" : "PREVIEW_ENVIRONMENT_INVALID");
    }
    assertProductionSafe(binding);
  }
  const timeoutHours = input.lifecycle?.timeoutHours ?? 168;
  if (!Number.isSafeInteger(timeoutHours) || timeoutHours < 1 || timeoutHours > MAX_TIMEOUT_HOURS) invalid();
  const reclaimOn = input.lifecycle?.reclaimOn ?? "pr_closed";
  if (reclaimOn !== "pr_closed" && reclaimOn !== "timeout") invalid();
  const branchRef = derivePreviewBranchRef(input.projectRef, input.previewRef);
  const components: PreviewEnvironmentComponent[] = [
    { name: "database", status: "planned", detail: `branch '${branchRef}' (${dataMode})` },
    { name: "application", status: "planned", detail: `release ${input.releaseId}` },
    { name: "configuration", status: "planned", detail: input.configurationId ? `configuration ${input.configurationId}` : "environment defaults" },
    { name: "resources", status: "planned", detail: resources.length > 0 ? resources.map(([name, binding]) => `${name} -> ${binding}`).join(", ") : "no declared resources" },
    { name: "queues", status: "planned", detail: `namespace '${branchRef}' with preview consumers` },
    { name: "storage", status: "planned", detail: `namespace '${branchRef}' scoped to the preview binding` },
    { name: "secrets", status: "planned", detail: "test credentials by reference only" },
  ];
  const preview: PreviewEnvironment = {
    schema: PREVIEW_ENVIRONMENT_SCHEMA,
    preview_ref: input.previewRef, project_ref: input.projectRef,
    application_id: input.applicationId, environment_id: input.environmentId, release_id: input.releaseId,
    source: { branch: input.source.branch, commit: input.source.commit }, data_mode: dataMode,
    branch_ref: branchRef, configuration_id: input.configurationId ?? null,
    resource_bindings: Object.fromEntries(resources),
    lifecycle: { reclaim_on: reclaimOn, timeout_hours: timeoutHours, residue: "delete_branch_and_namespace" },
    components, isolation: ISOLATION_REQUIREMENTS.map(check => ({ ...check, status: "pending" })),
    production_blocked: true,
    notes: [
      "Composition only: this plan does not provision and is not a running environment.",
      "A name-policy pass does not prove the resolved environment is non-production or isolated.",
      "Full-clone planning requires a trusted policy decision; execution must separately verify authorization and pre-masked data.",
      "Derived names are not ownership proof: creation and deletion must check the exact project and preview identity.",
      "Only named references are accepted; credentials must not be encoded in those references.",
    ],
  };
  if (Buffer.byteLength(JSON.stringify(preview, null, 2), "utf8") + 1 > MAX_OUTPUT_BYTES) invalid();
  return preview;
}
export interface PreviewReclaimCandidate {
  preview_ref: string;
  created_at: string;
  lifecycle: Pick<PreviewEnvironmentLifecycle, "reclaim_on" | "timeout_hours">;
}
/** Invalid stored deadlines never authorize cleanup. */
export function previewsDueForReclamation(previews: ReadonlyArray<PreviewReclaimCandidate>, now: Date): PreviewReclaimCandidate[] {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !Array.isArray(previews)) invalid();
  const timestamp = now.getTime();
  return previews.filter(preview => {
    if (!record(preview) || !record(preview.lifecycle)
      || !matches(preview.preview_ref, /^[A-Za-z0-9_-]{1,32}$/)
      || preview.lifecycle.reclaim_on !== "timeout"
      || !Number.isSafeInteger(preview.lifecycle.timeout_hours)
      || preview.lifecycle.timeout_hours < 1 || preview.lifecycle.timeout_hours > MAX_TIMEOUT_HOURS
      || typeof preview.created_at !== "string") return false;
    const created = Date.parse(preview.created_at);
    return Number.isFinite(created) && timestamp - created >= preview.lifecycle.timeout_hours * 3_600_000;
  });
}
