import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const schema = readFileSync(new URL("../../src/db/platform-v2.ts", import.meta.url), "utf8");
const databaseInit = readFileSync(new URL("../../src/db/init.ts", import.meta.url), "utf8");
const serverEntrypoint = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
const userSafetyService = readFileSync(
  new URL("../../src/services/user-safety.service.ts", import.meta.url),
  "utf8",
);
const taskRepository = readFileSync(
  new URL("../../src/repositories/task.repository.ts", import.meta.url),
  "utf8",
);

describe("platform v2 schema contract", () => {
  test("uses durable project-scoped control-plane tables", () => {
    for (const table of [
      "project_business_organizations",
      "project_business_organization_members",
      "project_business_organization_invitations",
      "project_business_organization_applications",
      "project_collaborators",
      "project_collaborator_invitations",
      "project_control_secrets",
      "secret_encryption_checkpoints",
      "supaoauth_bff_proof_nonces",
      "project_user_deletion_fences",
      "project_webhooks",
      "webhook_outbox",
      "webhook_deliveries",
      "audit_log_checkpoints",
      "audit_exports",
    ]) expect(schema).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
  });

  test("does not store webhook secrets in plaintext or allow audit mutation", () => {
    expect(schema).toContain("value_encrypted TEXT NOT NULL");
    expect(schema).toContain("'auth-hook', 'webhook'");
    expect(schema).toContain("migrateLegacyControlSecrets");
    expect(schema).toContain("migrateWebhookSecretsToControlStore");
    expect(schema).toContain("SET secret_encrypted = NULL, previous_secret_encrypted = NULL");
    expect(schema).toContain("audit_logs is append-only");
    expect(schema).toContain("BEFORE UPDATE OR DELETE ON audit_logs");
  });

  test("keeps deleted webhook history and orders hashed audit chains explicitly", () => {
    expect(schema).toContain("ALTER TABLE project_webhooks ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ");
    expect(schema).toContain("WHERE deleted_at IS NULL");
    expect(schema).toContain("ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS chain_sequence BIGINT");
    expect(schema).toContain("WITH RECURSIVE linked_audit_events AS");
    expect(schema).toContain("child.previous_hash = parent.event_hash");
    expect(schema).toContain("SET chain_sequence = resolved.chain_sequence");
    expect(schema).toContain("chain_sequence IS DISTINCT FROM resolved.chain_sequence");
  });

  test("runs the provider linking forward migration before runtime config is rendered", () => {
    expect(databaseInit).toContain("await migrateLegacyProviderLinkingConfig(transaction)");
    expect(serverEntrypoint).toContain("await migrateLegacyProviderLinkingConfig(controlPlaneSql)");
  });

  test("serializes task activation with durable GoTrue user deletion fences", () => {
    expect(schema).toContain("CREATE OR REPLACE FUNCTION enforce_project_user_deletion_fence()");
    expect(schema).toContain("pg_advisory_xact_lock(hashtextextended(");
    expect(schema).toContain("AND status IN ('requested', 'deleting', 'deleted')");
    expect(schema).toContain("operation_id UUID NOT NULL DEFAULT gen_random_uuid()");
    expect(schema).toContain("operation_expires_at TIMESTAMPTZ NOT NULL");
    expect(schema).toContain("ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS invoker_user_id UUID");
    expect(schema).toContain("ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS auth_authority_ref VARCHAR(20)");
    expect(schema).toContain("WHERE auth_authority_ref IS NULL");
    expect(schema).toContain("idx_project_tasks_authority_invoker_active");
    expect(schema).toContain("MESSAGE = 'TASK_AUTH_AUTHORITY_MISMATCH'");
    expect(schema).toContain("WHERE project_ref = NEW.auth_authority_ref");
    expect(schema).toContain("NEW.auth_authority_ref || ':' || NEW.invoker_user_id::text");
    expect(schema).toContain("MESSAGE = 'TASK_INVOKER_MISMATCH'");
    expect(schema).toContain("BEFORE INSERT OR UPDATE OF status, payload, project_ref, invoker_user_id, auth_authority_ref ON project_tasks");
    expect(schema).toContain("MESSAGE = 'USER_DELETION_FENCED'");
    expect(userSafetyService).toContain("projectUserLifecycleLockKey(projectRef, userId)");
    expect(userSafetyService).toContain("operation_expires_at > NOW() AS operation_active");
    expect(userSafetyService).toContain("AND operation_id = ${input.operationId}::uuid");
    expect(taskRepository).toContain("invoker_user_id = $6::uuid");
    expect(taskRepository).toContain("payload_invoker_user_id = $6::uuid");
    expect(databaseInit).toContain("WHERE auth_authority_ref IS NULL");
    expect(databaseInit).not.toContain("SET auth_authority_ref = project_ref\";");
  });
});
