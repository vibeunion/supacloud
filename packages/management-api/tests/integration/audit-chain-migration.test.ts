import { afterAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import {
  AUDIT_CHAIN_SEQUENCE_MIGRATION_KEY,
  assertPlatformMigrationCompleted,
  migrateAuditChainSequences,
} from "../../src/db/audit-chain-migration";
import { ensurePlatformV2Schema } from "../../src/db/platform-v2";

const database = new SQL({
  url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/postgres",
  max: 1,
});

type ReservedSql = Awaited<ReturnType<typeof database.reserve>>;

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

async function resetAuditFixture(transaction: SQL): Promise<void> {
  await transaction.unsafe("DROP TRIGGER IF EXISTS audit_logs_append_only ON audit_logs");
  await transaction.unsafe("DROP INDEX IF EXISTS audit_logs_event_hash_unique_idx");
  await transaction.unsafe("DROP INDEX IF EXISTS audit_logs_chain_parent_unique_idx");
  await transaction.unsafe("DROP INDEX IF EXISTS audit_logs_chain_sequence_unique_idx");
  await transaction`DELETE FROM audit_log_checkpoints`;
  await transaction`DELETE FROM platform_schema_migrations WHERE migration_key = ${AUDIT_CHAIN_SEQUENCE_MIGRATION_KEY}`;
  await transaction`DELETE FROM audit_logs`;
}

async function insertLinearChain(
  transaction: SQL,
  projectRef: string,
  eventCount: number,
  includeSequences: boolean,
): Promise<void> {
  await transaction`
    INSERT INTO audit_logs (
      id, project_ref, actor, actor_type, action, method, path, status,
      request_id, metadata, source, previous_hash, event_hash, chain_sequence, created_at
    )
    SELECT
      gen_random_uuid(), ${projectRef}, 'fixture', 'system', 'fixture', 'POST', '/fixture', 200,
      'request-' || event_number, '{}'::jsonb, 'migration-test',
      CASE WHEN event_number = 1 THEN NULL ELSE ${projectRef} || '-hash-' || (event_number - 1) END,
      ${projectRef} || '-hash-' || event_number,
      CASE WHEN ${includeSequences} THEN event_number ELSE NULL END,
      NOW() + event_number * INTERVAL '1 millisecond'
    FROM generate_series(1, ${eventCount}) event_number
  `;
}

async function insertCheckpointForHead(transaction: SQL, projectRef: string): Promise<void> {
  await transaction`
    INSERT INTO audit_log_checkpoints (
      project_ref, last_event_id, last_event_hash, event_count
    )
    SELECT ${projectRef}, id, event_hash, chain_sequence
    FROM audit_logs
    WHERE project_ref = ${projectRef}
    ORDER BY chain_sequence DESC
    LIMIT 1
  `;
}

async function markerCount(transaction: SQL): Promise<number> {
  const [marker] = await transaction<{ count: number | string }[]>`
    SELECT count(*) AS count
    FROM platform_schema_migrations
    WHERE migration_key = ${AUDIT_CHAIN_SEQUENCE_MIGRATION_KEY}
  `;
  return Number(marker?.count || 0);
}

async function expectRejectedMigration(transaction: SQL, message: RegExp): Promise<void> {
  let rejection: unknown;
  try {
    await migrateAuditChainSequences(transaction);
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).toMatch(message);
  expect(await markerCount(transaction)).toBe(0);
}

async function insertRawEvents(transaction: SQL, rows: Array<[string, string | null]>): Promise<void> {
  for (const [eventHash, previousHash] of rows) {
    await transaction`
      INSERT INTO audit_logs (
        id, project_ref, actor, actor_type, action, method, path, status,
        request_id, metadata, source, previous_hash, event_hash, created_at
      ) VALUES (
        gen_random_uuid(), 'invalid-chain', 'fixture', 'system', 'fixture', 'POST', '/fixture', 200,
        ${`request-${eventHash}`}, '{}'::jsonb, 'migration-test', ${previousHash}, ${eventHash}, NOW()
      )
    `;
  }
}

afterAll(async () => {
  await database.close();
}, 30_000);

describe("audit chain explicit platform migration", () => {
  test("marks empty init and stays idempotent", async () => {
    await withRollback(async (transaction) => {
      await resetAuditFixture(transaction);
      await migrateAuditChainSequences(transaction);
      await assertPlatformMigrationCompleted(transaction);
      await migrateAuditChainSequences(transaction);
      expect(await markerCount(transaction)).toBe(1);
    });
  }, 30_000);

  test("validates complete chains and backfills missing sequences and checkpoints", async () => {
    await withRollback(async (transaction) => {
      await resetAuditFixture(transaction);
      await insertLinearChain(transaction, "complete-chain", 3, true);
      await insertCheckpointForHead(transaction, "complete-chain");
      await insertLinearChain(transaction, "missing-sequence", 10_000, false);

      await migrateAuditChainSequences(transaction);

      const [summary] = await transaction<{ count: number | string; max: number | string }[]>`
        SELECT count(*) AS count, max(chain_sequence) AS max
        FROM audit_logs WHERE project_ref = 'missing-sequence'
      `;
      expect(Number(summary?.count)).toBe(10_000);
      expect(Number(summary?.max)).toBe(10_000);
      expect(await markerCount(transaction)).toBe(1);
    });
  }, 120_000);

  test("rejects duplicate, branch, orphan, cycle, and checkpoint mismatch without a marker", async () => {
    const invalidFixtures: Array<{ message: RegExp; rows: Array<[string, string | null]> }> = [
      { message: /duplicate event hash/, rows: [["same", null], ["same", null]] },
      { message: /branched parent/, rows: [["root", null], ["child-a", "root"], ["child-b", "root"]] },
      { message: /orphaned event/, rows: [["root", null], ["orphan", "missing"]] },
      { message: /unresolved cycle/, rows: [["root", null], ["cycle-a", "cycle-b"], ["cycle-b", "cycle-a"]] },
    ];
    for (const fixture of invalidFixtures) {
      await withRollback(async (transaction) => {
        await resetAuditFixture(transaction);
        await insertRawEvents(transaction, fixture.rows);
        await expectRejectedMigration(transaction, fixture.message);
      });
    }
    await withRollback(async (transaction) => {
      await resetAuditFixture(transaction);
      await insertLinearChain(transaction, "checkpoint-mismatch", 2, false);
      await transaction`
        INSERT INTO audit_log_checkpoints (
          project_ref, last_event_id, last_event_hash, event_count
        ) VALUES ('checkpoint-mismatch', NULL, 'wrong', 99)
      `;
      await expectRejectedMigration(transaction, /checkpoint mismatch/);
    });
  }, 30_000);

  test("keeps server schema and marker gate bounded with a large existing chain", async () => {
    await withRollback(async (transaction) => {
      await resetAuditFixture(transaction);
      await insertLinearChain(transaction, "server-fast-path", 25_000, true);
      await transaction`
        INSERT INTO platform_schema_migrations (migration_key)
        VALUES (${AUDIT_CHAIN_SEQUENCE_MIGRATION_KEY})
      `;
      const startedAt = performance.now();
      await ensurePlatformV2Schema(transaction);
      await assertPlatformMigrationCompleted(transaction);
      expect(performance.now() - startedAt).toBeLessThan(30_000);
    });
  }, 40_000);
});
