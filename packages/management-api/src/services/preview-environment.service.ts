import { AppError } from "../utils/errors";

/**
 * Deterministic composition of a **complete** preview environment. This is the
 * P1-5 definition slice: it names every component (database, application,
 * configuration, resources, queues, storage, secrets), the isolation checks a
 * preview must pass, and the reclamation policy. It does not provision or
 * connect to anything; provisioning is a later slice.
 */
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
  /** Optional immutable configuration revision for the environment. */
  configurationId?: string;
  /** Logical resource name -> opaque binding reference. */
  resources?: Readonly<Record<string, string>>;
  dataMode?: "schema_only" | "full_clone";
  /** Required for `full_clone`; absent means unauthorized. */
  authorizedFullClone?: boolean;
  lifecycle?: { reclaimOn?: "pr_closed" | "timeout"; timeoutHours?: number };
}

const PRODUCTION_SHAPE = /^(?:prod|production|live|release)(?:[-_]|$)/i;
const referenceName = /^[a-z][a-z0-9-]{0,15}:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TIMEOUT_HOURS = 24 * 30;

const ISOLATION_REQUIREMENTS: ReadonlyArray<{ key: PreviewIsolationCheckKey; requirement: string }> = [
  { key: "database_role", requirement: "The preview database role must not hold cluster-management privileges." },
  { key: "storage_permissions", requirement: "Storage access must be scoped to the preview project binding, not the parent." },
  { key: "consumer_identity", requirement: "Queue consumers must run under a preview-scoped identity." },
  { key: "route_access_control", requirement: "Preview routes must reject production credentials and must not be publicly indexed." },
];

function invalid(): never {
  throw new PreviewEnvironmentError("PREVIEW_ENVIRONMENT_INVALID");
}

function assertProductionSafe(value: string): void {
  if (PRODUCTION_SHAPE.test(value)) {
    throw new PreviewEnvironmentError("PREVIEW_ENVIRONMENT_PRODUCTION_FORBIDDEN");
  }
}

/**
 * Compose a complete preview environment from existing identifiers. The result
 * is a plan: every component starts `planned`, every isolation check starts
 * `pending`, and no credential is embedded.
 */
export function composePreviewEnvironment(input: PreviewComposeInput): PreviewEnvironment {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(input.previewRef)
    || !/^[A-Za-z0-9_-]{1,20}$/.test(input.projectRef)
    || !IDENTIFIER.test(input.applicationId)
    || !IDENTIFIER.test(input.environmentId)
    || !/^[a-f0-9]{64}$/.test(input.releaseId)
    || typeof input.source?.branch !== "string"
    || input.source.branch.length === 0 || input.source.branch.length > 255
    || /[\u0000-\u001f\u007f]/.test(input.source.branch) || input.source.branch.includes("..")
    || (input.source.commit !== "" && !/^[a-f0-9]{7,40}$/.test(input.source.commit))
    || (input.configurationId !== undefined && !uuid.test(input.configurationId))) invalid();

  assertProductionSafe(input.environmentId);
  assertProductionSafe(input.source.branch);

  const dataMode = input.dataMode ?? "schema_only";
  if (dataMode === "full_clone" && input.authorizedFullClone !== true) {
    throw new PreviewEnvironmentError("PREVIEW_ENVIRONMENT_FULL_CLONE_REQUIRES_AUTHORIZATION");
  }

  const resources = Object.entries(input.resources ?? {}).sort(([a], [b]) => a.localeCompare(b));
  for (const [name, binding] of resources) {
    if (name.length === 0 || name.length > 512 || /[\u0000-\u001f\u007f]/.test(name)) invalid();
    if (!referenceName.test(binding)) {
      throw new PreviewEnvironmentError(binding.includes("://") || binding.includes("@")
        ? "PREVIEW_ENVIRONMENT_INLINE_SECRET_FORBIDDEN"
        : "PREVIEW_ENVIRONMENT_INVALID");
    }
    assertProductionSafe(binding);
    assertProductionSafe(binding.slice(binding.indexOf(":") + 1));
  }

  const timeoutHours = input.lifecycle?.timeoutHours ?? 168;
  if (!Number.isSafeInteger(timeoutHours) || timeoutHours < 1 || timeoutHours > MAX_TIMEOUT_HOURS) invalid();
  const reclaimOn = input.lifecycle?.reclaimOn ?? "pr_closed";
  if (reclaimOn !== "pr_closed" && reclaimOn !== "timeout") invalid();

  const namespace = `preview-${input.previewRef}`;
  const components: PreviewEnvironmentComponent[] = [
    { name: "database", status: "planned", detail: `branch '${namespace}' (${dataMode})` },
    { name: "application", status: "planned", detail: `release ${input.releaseId}` },
    { name: "configuration", status: "planned", detail: input.configurationId ? `configuration ${input.configurationId}` : "environment defaults" },
    { name: "resources", status: "planned", detail: resources.length > 0 ? resources.map(([name, binding]) => `${name} -> ${binding}`).join(", ") : "no declared resources" },
    { name: "queues", status: "planned", detail: `namespace '${namespace}' with preview consumers` },
    { name: "storage", status: "planned", detail: `namespace '${namespace}' scoped to the preview binding` },
    { name: "secrets", status: "planned", detail: "test credentials by reference only" },
  ];

  return {
    schema: PREVIEW_ENVIRONMENT_SCHEMA,
    preview_ref: input.previewRef,
    project_ref: input.projectRef,
    application_id: input.applicationId,
    environment_id: input.environmentId,
    release_id: input.releaseId,
    source: { branch: input.source.branch, commit: input.source.commit },
    data_mode: dataMode,
    branch_ref: namespace,
    lifecycle: { reclaim_on: reclaimOn, timeout_hours: timeoutHours, residue: "delete_branch_and_namespace" },
    components,
    isolation: ISOLATION_REQUIREMENTS.map((check) => ({ ...check, status: "pending" as const })),
    production_blocked: true,
    notes: [
      "Composition only: this plan does not provision and is not a running environment.",
      "Default data_mode is schema_only; full_clone requires explicit authorization and pre-masked data.",
      "Production-shaped environments, branches and binding references are refused.",
      "Credentials are referenced by name only; no secret value is embedded.",
    ],
  };
}

export interface PreviewReclaimCandidate {
  preview_ref: string;
  created_at: string;
  lifecycle: Pick<PreviewEnvironmentLifecycle, "reclaim_on" | "timeout_hours">;
}

/** Pure timeout selection: which timeout-based previews should be reclaimed at `now`. */
export function previewsDueForReclamation(
  previews: ReadonlyArray<PreviewReclaimCandidate>,
  now: Date,
): PreviewReclaimCandidate[] {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) invalid();
  return previews.filter((preview) => {
    if (preview.lifecycle.reclaim_on !== "timeout") return false;
    const created = Date.parse(preview.created_at);
    if (!Number.isFinite(created)) return false;
    return timestamp - created >= preview.lifecycle.timeout_hours * 3_600_000;
  });
}