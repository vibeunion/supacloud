import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const schema = readFileSync(new URL("../../src/db/platform-v2.ts", import.meta.url), "utf8");
const auditMigration = readFileSync(
  new URL("../../src/db/audit-chain-migration.ts", import.meta.url),
  "utf8",
);
const mutationMigration = readFileSync(
  new URL("../../src/db/project-mutation-migration.ts", import.meta.url),
  "utf8",
);
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
      "project_mutations",
      "supaoauth_bff_proof_nonces",
      "project_user_deletion_fences",
      "project_webhooks",
      "webhook_outbox",
      "webhook_deliveries",
      "audit_log_checkpoints",
      "audit_exports",
    ]) expect(schema).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
  });

  test("keeps recoverable project mutations fenced, bounded, and free of credential columns", () => {
    const mutationSchema = schema.slice(
      schema.indexOf("CREATE TABLE IF NOT EXISTS project_mutations"),
      schema.indexOf("CREATE TABLE IF NOT EXISTS supaoauth_bff_proof_nonces"),
    );
    expect(mutationSchema).toContain("PRIMARY KEY (project_ref, mutation_id)");
    expect(mutationSchema).toContain("recovery_not_before TIMESTAMPTZ,");
    expect(mutationSchema).not.toContain("recovery_not_before TIMESTAMPTZ DEFAULT");
    expect(mutationSchema).toContain("ADD COLUMN IF NOT EXISTS recovery_not_before TIMESTAMPTZ");
    expect(mutationSchema).toContain("project_mutations_succeeded_response_check");
    expect(mutationSchema).toContain("project_mutations_recovery_due_v2_check");
    expect(mutationSchema).toContain("project_mutations_fencing_epoch_safe_check");
    expect(mutationSchema).toContain("fencing_epoch <= 9007199254740991");
    expect(mutationSchema).toContain("response_status IS NOT NULL AND response_status BETWEEN 200 AND 299");
    expect(mutationSchema).toContain("project_mutations_recovery_v2_idx");
    expect(mutationSchema).toContain("status IN ('running', 'failed_retryable')");
    expect(mutationSchema).not.toContain("status IN ('pending', 'running', 'failed_retryable')");
    expect(mutationSchema).toContain("project_mutations_active_resource_idx");
    expect(mutationSchema).not.toContain("DROP CONSTRAINT");
    expect(mutationMigration).toContain("INSERT INTO public.platform_schema_migrations");
    expect(mutationMigration).toContain("ALTER COLUMN recovery_not_before SET DEFAULT clock_timestamp()");
    expect(mutationMigration).toContain("ALTER COLUMN recovery_not_before DROP DEFAULT");
    expect(mutationMigration).toContain("COALESCE(updated_at, created_at, clock_timestamp())");
    expect(mutationMigration).toContain("20260813_project_mutation_recovery_contract_v4");
    expect(mutationMigration).toContain("DROP CONSTRAINT IF EXISTS project_mutations_recoverable_due_check");
    expect(mutationMigration).toContain("DROP INDEX IF EXISTS public.project_mutations_recovery_idx");
    expect(mutationMigration).toContain("project_mutation_resource_key_is_canonical_v1");
    expect(mutationMigration).toContain("canonical_id <> encoded_id");
    expect(mutationMigration).toContain("convert_from(decoded_id, 'UTF8')");
    expect(mutationMigration).toContain(
      "NOT public.project_mutation_resource_key_is_canonical_v1(mutation.resource_key)",
    );
    expect(mutationMigration).toContain("VALIDATE CONSTRAINT ${CANONICAL_RESOURCE_KEY_CONSTRAINT}");
    expect(mutationMigration).toContain("VALIDATE CONSTRAINT ${FENCING_EPOCH_SAFE_CONSTRAINT}");
    for (const sensitiveColumn of [
      "request_body", "request_headers", "request_payload", "credential", "service_role", "secret",
    ]) expect(mutationSchema).not.toContain(sensitiveColumn);
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

  test("idempotently upgrades legacy webhook outbox replay columns", () => {
    expect(schema).toContain("ALTER TABLE webhook_outbox ADD COLUMN IF NOT EXISTS replay_of_delivery_id UUID");
    expect(schema).toContain("ALTER TABLE webhook_outbox ADD COLUMN IF NOT EXISTS created_by TEXT");
  });

  test("moves audit chain backfill out of server schema bootstrap", () => {
    expect(schema).toContain("ALTER TABLE project_webhooks ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ");
    expect(schema).toContain("WHERE deleted_at IS NULL");
    expect(schema).toContain("ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS chain_sequence BIGINT");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS platform_schema_migrations");
    expect(schema).not.toContain("WITH RECURSIVE resolved_audit_chain AS");
    expect(schema).not.toContain("UPDATE audit_logs audit");
    expect(schema).not.toContain("audit_logs_event_hash_unique_idx");
    expect(schema).toContain("audit_logs_project_hash_idx");
    expect(schema).toContain("audit_logs_project_sequence_idx");
    expect(schema).toContain("IF NOT EXISTS (");
    expect(schema).not.toContain("DROP TRIGGER IF EXISTS audit_logs_append_only");
    expect(auditMigration).toContain("WITH RECURSIVE resolved_audit_chain AS");
    expect(auditMigration).toContain("child.previous_hash = parent.event_hash");
    expect(auditMigration).toContain("UPDATE audit_logs audit");
    expect(auditMigration).toContain("INSERT INTO platform_schema_migrations");
    expect(auditMigration).toContain("DROP TRIGGER IF EXISTS audit_logs_append_only");
  });

  test("runs the provider linking forward migration before runtime config is rendered", () => {
    expect(databaseInit).toContain("await migrateLegacyProviderLinkingConfig(transaction)");
    expect(serverEntrypoint).toContain("await migrateLegacyProviderLinkingConfig(controlPlaneSql)");
  });

  test("requires the durable audit migration marker before server startup continues", () => {
    expect(databaseInit).toContain("await migrateProjectMutationJournal(transaction)");
    expect(serverEntrypoint).toContain("await ensurePlatformV2SchemaInTransaction(controlPlaneSql)");
    expect(databaseInit).toContain("await migrateAuditChainSequences(transaction)");
    expect(serverEntrypoint).toContain("await assertPlatformMigrationCompleted(controlPlaneSql)");
    expect(serverEntrypoint.indexOf("await assertPlatformMigrationCompleted(controlPlaneSql)"))
      .toBeLessThan(serverEntrypoint.indexOf("await migrateLegacyProjectWebhooks(controlPlaneSql)"));
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
