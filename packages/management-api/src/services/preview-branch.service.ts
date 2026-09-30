import type { PreviewComposeInput, PreviewReclaimTrigger } from "./preview-environment.service";

/**
 * Structural mirror of the existing Supabase-compatible branch record stored in
 * `projects.config.branches` (see `routes/branches.ts` and
 * `auto-branching.service.ts`). A preview must run on this branch, not create a
 * parallel namespace, so the two models stay one.
 */
export interface PreviewBranchRecord {
  ref: string;
  name: string;
  parent_ref: string;
  status: "creating" | "active" | "deleting" | "error";
  created_at: string;
  data_mode?: "schema_only" | "full_clone";
  /** Set by auto-branching from the git push/webhook context. */
  git_branch?: string;
  git_commit?: string;
  /** Supabase branch lifetime: persistent branches are not auto-reclaimed. */
  branch_type?: "preview" | "persistent";
}

export interface PreviewFromBranchInput {
  projectRef: string;
  branch: PreviewBranchRecord;
  applicationId: string;
  environmentId: string;
  releaseId: string;
  configurationId?: string;
  resources?: Readonly<Record<string, string>>;
  queueNames?: ReadonlyArray<string>;
  storageBuckets?: ReadonlyArray<string>;
  authorizedFullClone?: boolean;
  lifecycle?: { reclaimOn?: PreviewReclaimTrigger; timeoutHours?: number };
}

/**
 * Build a preview composition input from an existing branch record, reusing the
 * branch ref as the preview identity so provisioning targets the branch the
 * platform already created (and the CLI/webhook already know about).
 */
export function previewInputFromBranch(input: PreviewFromBranchInput): PreviewComposeInput {
  const { branch } = input;
  return {
    previewRef: branch.ref,
    projectRef: input.projectRef,
    applicationId: input.applicationId,
    environmentId: input.environmentId,
    releaseId: input.releaseId,
    branchRef: branch.ref,
    branchType: branch.branch_type ?? "preview",
    source: { branch: branch.git_branch ?? branch.name, commit: branch.git_commit ?? "" },
    ...(input.configurationId ? { configurationId: input.configurationId } : {}),
    ...(input.resources ? { resources: input.resources } : {}),
    ...(input.queueNames ? { queueNames: input.queueNames } : {}),
    ...(input.storageBuckets ? { storageBuckets: input.storageBuckets } : {}),
    ...(branch.data_mode ? { dataMode: branch.data_mode } : {}),
    ...(input.authorizedFullClone === undefined ? {} : { authorizedFullClone: input.authorizedFullClone }),
    ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
  };
}

/** Whether the branch is eligible to back a preview (owned by the project and active). */
export function isPreviewBranchEligible(projectRef: string, branch: PreviewBranchRecord): boolean {
  return branch.parent_ref === projectRef && branch.status === "active";
}