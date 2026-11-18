import { parseWorkspaceReleaseApproval, type WorkspaceReleaseApproval } from "@supacloud/delivery";
import { sql } from "../db";
import type { WorkspaceApprovalStore } from "./workspace-release-approval";

type Row = Record<string, unknown>;

function rowToApproval(row: Row): WorkspaceReleaseApproval {
  return parseWorkspaceReleaseApproval({
    schema: "supacloud.workspace-release-approval.v1",
    approval_id: row.approval_id,
    repository_id: row.repository_id,
    repository: row.repository,
    project_ref: row.project_ref,
    application_id: row.application_id,
    environment_id: row.environment_id,
    release_id: row.release_id,
    manifest_sha256: row.manifest_sha256,
    config_digest: row.config_digest,
    source_revision: row.source_revision,
    workspace_plan_sha256: row.workspace_plan_sha256,
    actor: row.actor,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  });
}

/** Durable approval store. It does not record deployment success. */
export class SqlWorkspaceApprovalStore implements WorkspaceApprovalStore {
  async putIfAbsent(record: WorkspaceReleaseApproval): Promise<{ record: WorkspaceReleaseApproval; inserted: boolean }> {
    const parsed = parseWorkspaceReleaseApproval(record);
    const inserted = await sql`
      INSERT INTO workspace_release_approvals (
        approval_id, project_ref, repository_id, repository, application_id, environment_id,
        release_id, manifest_sha256, config_digest, source_revision, workspace_plan_sha256, actor, created_at
      ) VALUES (
        ${parsed.approval_id}, ${parsed.project_ref}, ${parsed.repository_id}, ${parsed.repository},
        ${parsed.application_id}, ${parsed.environment_id}, ${parsed.release_id}, ${parsed.manifest_sha256},
        ${parsed.config_digest}, ${parsed.source_revision}, ${parsed.workspace_plan_sha256}, ${parsed.actor},
        ${parsed.created_at}
      )
      ON CONFLICT (approval_id) DO NOTHING
      RETURNING approval_id
    ` as Row[];
    const stored = await this.get(parsed.project_ref, parsed.approval_id);
    if (!stored) throw new Error("WORKSPACE_APPROVAL_NOT_STORED");
    return { record: stored, inserted: inserted.length > 0 };
  }

  async get(projectRef: string, approvalId: string): Promise<WorkspaceReleaseApproval | null> {
    const rows = await sql`
      SELECT approval_id, project_ref, repository_id, repository, application_id, environment_id,
             release_id, manifest_sha256, config_digest, source_revision, workspace_plan_sha256, actor, created_at
      FROM workspace_release_approvals
      WHERE project_ref = ${projectRef} AND approval_id = ${approvalId}
      LIMIT 1
    ` as Row[];
    const row = rows[0];
    return row ? rowToApproval(row) : null;
  }
}
