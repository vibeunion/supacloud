import { afterAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import {
  PROJECT_MUTATION_JOURNAL_MIGRATION_KEY,
  PROJECT_MUTATION_RECOVERY_CONTRACT_MIGRATION_KEY,
  migrateProjectMutationJournal,
} from "../../src/db/project-mutation-migration";

const database = new SQL({
  url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/postgres",
  max: 1,
});

async function withRollback(operation: (transaction: SQL) => Promise<void>): Promise<void> {
  const connection = await database.reserve();
  await connection.unsafe("BEGIN");
  try {
    await operation(connection as unknown as SQL);
  } finally {
    await connection.unsafe("ROLLBACK");
    connection.release();
  }
}

async function insertProjectFixture(transaction: SQL, projectRef: string): Promise<void> {
  await transaction`
    INSERT INTO projects (
      ref, name, db_name, db_user, db_password, jwt_secret,
      anon_key, service_role_key, s3_bucket, status
    ) VALUES (
      ${projectRef}, 'Mutation migration fixture', ${`db_${projectRef}`}, ${`user_${projectRef}`},
      'fixture-password', 'fixture-jwt-secret', 'fixture-anon-key',
      'fixture-service-role-key', ${`bucket-${projectRef}`}, 'active'
    )
  `;
}

async function insertLegacyMutation(
  transaction: SQL,
  projectRef: string,
  status: "pending" | "failed_retryable" | "succeeded",
  resourceKey: string | null = null,
  recoveryNotBefore: Date | null = null,
): Promise<string> {
  const mutationId = crypto.randomUUID();
  await transaction`
    INSERT INTO project_mutations (
      project_ref, mutation_id, operation, request_fingerprint,
      principal_type, principal_id, resource_key, status, response_status,
      recovery_not_before, completed_at
    ) VALUES (
      ${projectRef}, ${mutationId}, 'scheduled_functions.create', ${"a".repeat(64)},
      'project', ${`project:${projectRef}`}, ${resourceKey}, ${status},
      ${status === "succeeded" ? 200 : null}, ${recoveryNotBefore},
      ${status === "succeeded" ? new Date() : null}
    )
  `;
  return mutationId;
}

async function dropResourceKeyConstraints(transaction: SQL): Promise<void> {
  await transaction.unsafe(`
    ALTER TABLE project_mutations
    DROP CONSTRAINT IF EXISTS project_mutations_resource_key_check
  `);
  await transaction.unsafe(`
    ALTER TABLE project_mutations
    DROP CONSTRAINT IF EXISTS project_mutations_resource_key_canonical_v1_check
  `);
}

afterAll(async () => {
  await database.close();
}, 30_000);

describe("project mutation PostgreSQL forward migration", () => {
  test("evolves a completed v3 database without scheduling pending rows for recovery", async () => {
    await withRollback(async (transaction) => {
      await transaction.unsafe(`
        ALTER TABLE project_mutations
        DROP CONSTRAINT IF EXISTS project_mutations_recoverable_due_check
      `);
      await transaction.unsafe(`
        ALTER TABLE project_mutations
        DROP CONSTRAINT IF EXISTS project_mutations_recovery_due_v2_check
      `);
      await transaction.unsafe(`
        ALTER TABLE project_mutations
        ALTER COLUMN recovery_not_before SET DEFAULT clock_timestamp()
      `);
      await transaction.unsafe("DROP INDEX IF EXISTS project_mutations_recovery_v2_idx");
      await transaction.unsafe(`
        CREATE INDEX IF NOT EXISTS project_mutations_recovery_idx
        ON project_mutations(operation, recovery_not_before, updated_at, mutation_id)
        WHERE recovery_not_before IS NOT NULL
          AND status IN ('pending', 'running', 'failed_retryable')
      `);
      await transaction`
        DELETE FROM platform_schema_migrations
        WHERE migration_key = ${PROJECT_MUTATION_RECOVERY_CONTRACT_MIGRATION_KEY}
      `;
      await transaction`
        INSERT INTO platform_schema_migrations (migration_key)
        VALUES (${PROJECT_MUTATION_JOURNAL_MIGRATION_KEY})
        ON CONFLICT (migration_key) DO NOTHING
      `;
      const projectRef = `mm${process.pid.toString(36)}${Date.now().toString(36)}`.slice(0, 20);
      await insertProjectFixture(transaction, projectRef);
      const pendingMutationId = await insertLegacyMutation(
        transaction,
        projectRef,
        "pending",
        null,
        new Date(),
      );
      const retryableMutationId = await insertLegacyMutation(
        transaction,
        projectRef,
        "failed_retryable",
      );

      await migrateProjectMutationJournal(transaction);
      await migrateProjectMutationJournal(transaction);

      const mutations = await transaction`
        SELECT mutation_id, recovery_not_before
        FROM project_mutations
        WHERE project_ref = ${projectRef}
          AND mutation_id IN (${pendingMutationId}, ${retryableMutationId})
      `;
      const [constraint] = await transaction`
        SELECT convalidated
        FROM pg_constraint
        WHERE conrelid = 'project_mutations'::regclass
          AND conname = 'project_mutations_recovery_due_v2_check'
      `;
      const [columnDefault] = await transaction`
        SELECT column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'project_mutations'
          AND column_name = 'recovery_not_before'
      `;
      const indexes = await transaction`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'project_mutations'
          AND indexname IN ('project_mutations_recovery_idx', 'project_mutations_recovery_v2_idx')
      `;
      const [marker] = await transaction`
        SELECT count(*)::integer AS count
        FROM platform_schema_migrations
        WHERE migration_key = ${PROJECT_MUTATION_RECOVERY_CONTRACT_MIGRATION_KEY}
      `;

      const recoveryByMutation = new Map(
        mutations.map((mutation) => [String(mutation.mutation_id), mutation.recovery_not_before]),
      );
      expect(recoveryByMutation.get(pendingMutationId)).toBeNull();
      expect(recoveryByMutation.get(retryableMutationId)).not.toBeNull();
      expect(constraint.convalidated).toBe(true);
      expect(columnDefault.column_default).toBeNull();
      expect(indexes).toEqual([{ indexname: "project_mutations_recovery_v2_idx" }]);
      expect(marker.count).toBe(1);
    });
  }, 30_000);

  test.each(["pending", "succeeded"] as const)(
    "rejects a legacy raw resource key on a %s row before recording the marker",
    async (status) => {
      await withRollback(async (transaction) => {
        await dropResourceKeyConstraints(transaction);
        await transaction`
          DELETE FROM platform_schema_migrations
          WHERE migration_key = ${PROJECT_MUTATION_JOURNAL_MIGRATION_KEY}
        `;
        const projectRef = `mr${status[0]}${process.pid.toString(36)}${Date.now().toString(36)}`.slice(0, 20);
        await insertProjectFixture(transaction, projectRef);
        await insertLegacyMutation(
          transaction,
          projectRef,
          status,
          "scheduled-function:nightly",
          status === "pending" ? new Date() : null,
        );

        await expect(migrateProjectMutationJournal(transaction))
          .rejects.toThrow("requires canonical v1 resource keys");

        const [marker] = await transaction`
          SELECT count(*)::integer AS count
          FROM platform_schema_migrations
          WHERE migration_key = ${PROJECT_MUTATION_JOURNAL_MIGRATION_KEY}
        `;
        expect(marker.count).toBe(0);
      });
    },
    30_000,
  );

  test.each([
    ["length modulo four equals one", "v1/edge-function/A"],
    ["non-zero trailing bits", "v1/edge-function/YR"],
    ["decoded bytes are not UTF-8", "v1/edge-function/_w"],
  ])("rejects a structurally valid but non-canonical key whose %s", async (_case, resourceKey) => {
    await withRollback(async (transaction) => {
      await dropResourceKeyConstraints(transaction);
      await transaction`
        DELETE FROM platform_schema_migrations
        WHERE migration_key = ${PROJECT_MUTATION_JOURNAL_MIGRATION_KEY}
      `;
      const projectRef = `mc${process.pid.toString(36)}${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`
        .slice(0, 20);
      await insertProjectFixture(transaction, projectRef);
      await insertLegacyMutation(transaction, projectRef, "pending", resourceKey, new Date());

      await expect(migrateProjectMutationJournal(transaction))
        .rejects.toThrow("requires canonical v1 resource keys");

      const [marker] = await transaction`
        SELECT count(*)::integer AS count
        FROM platform_schema_migrations
        WHERE migration_key = ${PROJECT_MUTATION_JOURNAL_MIGRATION_KEY}
      `;
      expect(marker.count).toBe(0);
    });
  }, 30_000);

  test.each([
    ["leading non-breaking space", `v1/edge-function/${Buffer.from("\u00a0nightly").toString("base64url")}`],
    ["trailing em space", `v1/edge-function/${Buffer.from("nightly\u2003").toString("base64url")}`],
    ["leading byte-order mark", `v1/edge-function/${Buffer.from("\ufeffnightly").toString("base64url")}`],
    ["C0 control character", `v1/edge-function/${Buffer.from("nightly\u0001").toString("base64url")}`],
    ["DEL control character", `v1/edge-function/${Buffer.from("nightly\u007f").toString("base64url")}`],
    ["C1 control character", `v1/edge-function/${Buffer.from("nightly\u0085").toString("base64url")}`],
  ])("rejects a canonical encoding whose decoded id has %s", async (_case, resourceKey) => {
    await withRollback(async (transaction) => {
      await transaction`
        DELETE FROM public.platform_schema_migrations
        WHERE migration_key = ${PROJECT_MUTATION_JOURNAL_MIGRATION_KEY}
      `;
      await migrateProjectMutationJournal(transaction);

      const [validation] = await transaction`
        SELECT public.project_mutation_resource_key_is_canonical_v1(${resourceKey}) AS canonical
      `;

      expect(validation.canonical).toBe(false);
    });
  }, 30_000);

  test("accepts a canonical encoding of an ordinary Unicode resource id", async () => {
    await withRollback(async (transaction) => {
      await transaction`
        DELETE FROM public.platform_schema_migrations
        WHERE migration_key = ${PROJECT_MUTATION_JOURNAL_MIGRATION_KEY}
      `;
      await migrateProjectMutationJournal(transaction);
      const resourceKey = `v1/edge-function/${Buffer.from("夜班/worker").toString("base64url")}`;

      const [validation] = await transaction`
        SELECT public.project_mutation_resource_key_is_canonical_v1(${resourceKey}) AS canonical
      `;

      expect(validation.canonical).toBe(true);
    });
  }, 30_000);

  test("propagates a validator dependency permission failure", async () => {
    await withRollback(async (transaction) => {
      await transaction`
        DELETE FROM public.platform_schema_migrations
        WHERE migration_key = ${PROJECT_MUTATION_JOURNAL_MIGRATION_KEY}
      `;
      await migrateProjectMutationJournal(transaction);
      await transaction.unsafe("CREATE SCHEMA validator_dependency_failure");
      await transaction.unsafe(
        `
          CREATE FUNCTION validator_dependency_failure.decode(TEXT, TEXT)
          RETURNS BYTEA
          LANGUAGE plpgsql
          IMMUTABLE
          AS $function$
          BEGIN
            RAISE EXCEPTION USING
              ERRCODE = '42501',
              MESSAGE = 'validator dependency permission failure';
          END;
          $function$
        `,
      );
      await transaction.unsafe(`
        ALTER FUNCTION public.project_mutation_resource_key_is_canonical_v1(TEXT)
        SET search_path = validator_dependency_failure, pg_catalog
      `);

      let dependencyError: unknown = null;
      try {
        await transaction.unsafe(
          "SELECT public.project_mutation_resource_key_is_canonical_v1('v1/edge-function/bmlnaHRseQ')",
        );
      } catch (error) {
        dependencyError = error;
      }

      expect(dependencyError).toBeInstanceOf(Error);
      expect((dependencyError as Error).message).toContain("validator dependency permission failure");
      expect((dependencyError as { errno?: string }).errno).toBe("42501");
    });
  }, 30_000);
});
