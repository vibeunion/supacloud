import type { SQL } from "bun";
import { executeSqlStatements } from "./sql-statements";

export const WORKSPACE_RELEASE_APPROVAL_TABLE = "workspace_release_approvals";

/** Approval records are not deployment receipts and do not activate a release. */
export async function ensureWorkspaceReleaseApprovalSchema(transaction: SQL): Promise<void> {
  await executeSqlStatements(transaction, `
    CREATE TABLE IF NOT EXISTS workspace_release_approvals (
      approval_id char(64) PRIMARY KEY,
      project_ref varchar(20) NOT NULL REFERENCES projects(ref) ON DELETE CASCADE,
      repository_id char(64) NOT NULL,
      repository varchar(200) NOT NULL,
      application_id varchar(64) NOT NULL,
      environment_id varchar(64) NOT NULL,
      release_id char(64) NOT NULL,
      manifest_sha256 char(64) NOT NULL,
      config_digest char(64) NOT NULL,
      source_revision char(64) NOT NULL,
      workspace_plan_sha256 char(64) NOT NULL,
      actor varchar(256) NOT NULL,
      created_at timestamptz NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS workspace_release_approvals_identity
      ON workspace_release_approvals (
        project_ref, repository_id, application_id, environment_id, release_id,
        manifest_sha256, config_digest, source_revision, workspace_plan_sha256
      );
  `);
}
