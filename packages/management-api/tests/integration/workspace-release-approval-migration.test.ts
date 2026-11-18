import { afterAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { parseWorkspaceReleaseApproval, workspaceApprovalId, workspaceRepositoryId } from "@supacloud/delivery";
import { ensureWorkspaceReleaseApprovalSchema } from "../../src/db/workspace-release-approval-schema";

const database = new SQL({
  url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/postgres",
  max: 1,
});

let unavailable = "";

async function reachable(): Promise<boolean> {
  try {
    await database`SELECT 1`;
    return true;
  } catch (error) {
    unavailable = error instanceof Error ? error.message : "PostgreSQL is unavailable";
    return false;
  }
}

afterAll(async () => {
  await database.close();
});

const postgres = await reachable();

(postgres ? test : test.skip)("workspace approval schema is created by the platform helper and keeps the first grant", async () => {
  const connection = await database.reserve();
  await connection.unsafe("BEGIN");
  try {
    // The approval DDL references projects. This transaction creates that parent
    // only when this server has no platform catalog, then rolls every change back.
    await connection.unsafe(`
      CREATE TABLE IF NOT EXISTS projects (
        ref varchar(20) PRIMARY KEY,
        name text, db_name text, db_user text, db_password text, jwt_secret text,
        anon_key text, service_role_key text, s3_bucket text, status text
      )
    `);
    await ensureWorkspaceReleaseApprovalSchema(connection as unknown as SQL);
    const projectRef = "ws-approval";
    await connection`
      INSERT INTO projects (
        ref, name, db_name, db_user, db_password, jwt_secret,
        anon_key, service_role_key, s3_bucket, status
      ) VALUES (
        ${projectRef}, 'Workspace approval fixture', ${`db_${projectRef}`}, ${`user_${projectRef}`},
        'fixture-password', 'fixture-jwt-secret', 'fixture-anon-key',
        'fixture-service-role-key', ${`bucket-${projectRef}`}, 'active'
      )
    `;
    const identity = {
      repository: "github.com/acme/store", project_ref: projectRef, application_id: "storefront",
      environment_id: "production", release_id: "a".repeat(64), manifest_sha256: "b".repeat(64),
      config_digest: "c".repeat(64), source_revision: "d".repeat(40), workspace_plan_sha256: "e".repeat(64),
    };
    const record = parseWorkspaceReleaseApproval({
      schema: "supacloud.workspace-release-approval.v1", ...identity,
      repository_id: workspaceRepositoryId(identity.repository), approval_id: workspaceApprovalId(identity),
      actor: "user-1", created_at: "2026-11-18T00:00:00.000Z",
    });
    await connection`
      INSERT INTO workspace_release_approvals (
        approval_id, project_ref, repository_id, repository, application_id, environment_id,
        release_id, manifest_sha256, config_digest, source_revision, workspace_plan_sha256, actor, created_at
      ) VALUES (
        ${record.approval_id}, ${record.project_ref}, ${record.repository_id}, ${record.repository},
        ${record.application_id}, ${record.environment_id}, ${record.release_id}, ${record.manifest_sha256},
        ${record.config_digest}, ${record.source_revision}, ${record.workspace_plan_sha256}, ${record.actor},
        ${record.created_at}
      )
    `;
    const again = await connection`
      INSERT INTO workspace_release_approvals (
        approval_id, project_ref, repository_id, repository, application_id, environment_id,
        release_id, manifest_sha256, config_digest, source_revision, workspace_plan_sha256, actor, created_at
      ) VALUES (
        ${record.approval_id}, ${record.project_ref}, ${record.repository_id}, ${record.repository},
        ${record.application_id}, ${record.environment_id}, ${record.release_id}, ${record.manifest_sha256},
        ${record.config_digest}, ${record.source_revision}, ${record.workspace_plan_sha256}, 'user-2',
        ${record.created_at}
      )
      ON CONFLICT (approval_id) DO NOTHING
      RETURNING actor
    `;
    expect(again).toEqual([]);
    const stored = await connection`SELECT actor, source_revision FROM workspace_release_approvals WHERE approval_id = ${record.approval_id}`;
    expect(stored[0]?.actor).toBe("user-1");
    expect(stored[0]?.source_revision).toBe(identity.source_revision);
  } finally {
    await connection.unsafe("ROLLBACK");
    connection.release();
  }
});
