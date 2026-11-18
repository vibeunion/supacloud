import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { canonical, digest } from "./delivery-files";
import { ApplicationIdSchema, ApplicationReleaseIdSchema } from "./application-release";

export const WORKSPACE_RELEASE_APPROVAL_SCHEMA = "supacloud.workspace-release-approval.v1";

const sha256 = ApplicationReleaseIdSchema;
const projectRef = Type.String({ pattern: "^[a-z0-9-]{1,20}$" });
const revision = Type.String({ pattern: "^[a-f0-9]{40}(?:[a-f0-9]{24})?$" });
const repository = Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9][A-Za-z0-9._/-]*$" });

export const WorkspaceReleaseApprovalSchema = Type.Object({
  schema: Type.Literal(WORKSPACE_RELEASE_APPROVAL_SCHEMA),
  approval_id: sha256,
  repository_id: sha256,
  repository,
  project_ref: projectRef,
  application_id: ApplicationIdSchema,
  environment_id: ApplicationIdSchema,
  release_id: sha256,
  manifest_sha256: sha256,
  config_digest: sha256,
  source_revision: revision,
  workspace_plan_sha256: sha256,
  actor: Type.String({ minLength: 1, maxLength: 256 }),
  created_at: Type.String(),
}, { additionalProperties: false });

export type WorkspaceReleaseApproval = Static<typeof WorkspaceReleaseApprovalSchema>;
export type WorkspaceReleaseApprovalIdentity = Omit<WorkspaceReleaseApproval, "schema" | "approval_id" | "repository_id" | "actor" | "created_at"> & {
  repository: string;
};

const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export function workspaceRepositoryId(repositoryName: string): string {
  if (!REPOSITORY_PATTERN.test(repositoryName)) {
    throw new Error("Invalid workspace repository identity");
  }
  return createHash("sha256").update(repositoryName).digest("hex");
}

export function workspaceApprovalIdentity(input: WorkspaceReleaseApprovalIdentity): Record<string, string> {
  return {
    repository_id: workspaceRepositoryId(input.repository),
    project_ref: input.project_ref,
    application_id: input.application_id,
    environment_id: input.environment_id,
    release_id: input.release_id,
    manifest_sha256: input.manifest_sha256,
    config_digest: input.config_digest,
    source_revision: input.source_revision,
    workspace_plan_sha256: input.workspace_plan_sha256,
  };
}

export function workspaceApprovalId(input: WorkspaceReleaseApprovalIdentity): string {
  return digest(canonical(workspaceApprovalIdentity(input)));
}

export function parseWorkspaceReleaseApproval(value: unknown): WorkspaceReleaseApproval {
  if (!Value.Check(WorkspaceReleaseApprovalSchema, value)
    || !Number.isFinite(Date.parse(value.created_at))
    || new Date(value.created_at).toISOString() !== value.created_at
    || value.repository_id !== workspaceRepositoryId(value.repository)
    || value.approval_id !== workspaceApprovalId(value)) {
    throw new Error("Invalid workspace release approval");
  }
  return structuredClone(value);
}
