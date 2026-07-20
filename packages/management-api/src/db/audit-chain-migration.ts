import type { SQL } from "bun";
import {
  AUDIT_CHAIN_SEQUENCE_MIGRATION_KEY,
  acquireAuditChainMigrationLock,
} from "./audit-chain-lock";

export { AUDIT_CHAIN_SEQUENCE_MIGRATION_KEY } from "./audit-chain-lock";

const AUDIT_CHAIN_RESOLUTION_CTE = `
  WITH RECURSIVE resolved_audit_chain AS (
    SELECT id, project_ref, event_hash, 1::bigint AS chain_sequence
    FROM audit_logs
    WHERE event_hash IS NOT NULL AND previous_hash IS NULL
    UNION ALL
    SELECT child.id, child.project_ref, child.event_hash, parent.chain_sequence + 1
    FROM resolved_audit_chain parent
    JOIN audit_logs child
      ON child.project_ref IS NOT DISTINCT FROM parent.project_ref
     AND child.previous_hash = parent.event_hash
     AND child.event_hash IS NOT NULL
  )
`;
const AUDIT_CHAIN_HEADS_CTE = `
  WITH audit_chain_heads AS (
    SELECT DISTINCT ON (project_ref)
      COALESCE(project_ref, '__platform__') AS project_key,
      id AS last_event_id,
      event_hash AS last_event_hash,
      count(*) OVER (PARTITION BY project_ref) AS event_count
    FROM audit_logs
    WHERE event_hash IS NOT NULL
    ORDER BY project_ref, chain_sequence DESC, id DESC
  )
`;

type ViolationCount = { violation_count: number | string };
type ResolutionCounts = {
  unresolved_count: number | string;
  sequence_mismatch_count: number | string;
};
type MigrationSummary = {
  hashed_event_count: number | string;
  project_chain_count: number | string;
};

export class PlatformMigrationRequiredError extends Error {
  readonly code = "platform_migration_required" as const;

  constructor() {
    super(
      `Required platform migration ${AUDIT_CHAIN_SEQUENCE_MIGRATION_KEY} is incomplete. Run supacloud --init-db before starting the server.`,
    );
    this.name = "PlatformMigrationRequiredError";
  }
}

function assertNoViolations(label: string, violation: ViolationCount | undefined): void {
  const count = Number(violation?.violation_count || 0);
  if (count > 0) throw new Error(`Audit chain migration rejected ${count} ${label}`);
}

async function migrationIsCompleted(transaction: SQL): Promise<boolean> {
  const [marker] = await transaction`
    SELECT migration_key
    FROM platform_schema_migrations
    WHERE migration_key = ${AUDIT_CHAIN_SEQUENCE_MIGRATION_KEY}
  `;
  return marker?.migration_key === AUDIT_CHAIN_SEQUENCE_MIGRATION_KEY;
}

async function assertNoDuplicateHashes(transaction: SQL): Promise<void> {
  const [violation] = await transaction<ViolationCount[]>`
    SELECT count(*) AS violation_count
    FROM (
      SELECT event_hash
      FROM audit_logs
      WHERE event_hash IS NOT NULL
      GROUP BY event_hash
      HAVING count(*) > 1
    ) duplicate_hashes
  `;
  assertNoViolations("duplicate event hash group(s)", violation);
}

async function assertNoBranches(transaction: SQL): Promise<void> {
  const [violation] = await transaction<ViolationCount[]>`
    SELECT count(*) AS violation_count
    FROM (
      SELECT project_ref, previous_hash
      FROM audit_logs
      WHERE event_hash IS NOT NULL AND previous_hash IS NOT NULL
      GROUP BY project_ref, previous_hash
      HAVING count(*) > 1
    ) branched_parents
  `;
  assertNoViolations("branched parent hash(es)", violation);
}

async function assertNoOrphans(transaction: SQL): Promise<void> {
  const [violation] = await transaction<ViolationCount[]>`
    SELECT count(*) AS violation_count
    FROM audit_logs child
    WHERE child.event_hash IS NOT NULL
      AND child.previous_hash IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM audit_logs parent
        WHERE parent.project_ref IS NOT DISTINCT FROM child.project_ref
          AND parent.event_hash = child.previous_hash
      )
  `;
  assertNoViolations("orphaned event(s)", violation);
}

async function assertOneRootPerChain(transaction: SQL): Promise<void> {
  const [violation] = await transaction<ViolationCount[]>`
    SELECT count(*) AS violation_count
    FROM (
      SELECT project_ref
      FROM audit_logs
      WHERE event_hash IS NOT NULL
      GROUP BY project_ref
      HAVING count(*) FILTER (WHERE previous_hash IS NULL) <> 1
    ) invalid_roots
  `;
  assertNoViolations("project chain(s) without exactly one root", violation);
}

async function createAuditChainIndexes(transaction: SQL): Promise<void> {
  await transaction.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_event_hash_unique_idx
      ON audit_logs(event_hash) WHERE event_hash IS NOT NULL
  `);
  await transaction.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_chain_parent_unique_idx
      ON audit_logs(project_ref, previous_hash) NULLS NOT DISTINCT
      WHERE event_hash IS NOT NULL AND previous_hash IS NOT NULL
  `);
}

async function assertResolutionIsComplete(transaction: SQL): Promise<void> {
  const [counts] = await transaction.unsafe(`
    ${AUDIT_CHAIN_RESOLUTION_CTE}
    SELECT
      count(*) FILTER (WHERE resolved.id IS NULL) AS unresolved_count,
      count(*) FILTER (
        WHERE resolved.id IS NOT NULL
          AND audit.chain_sequence IS NOT NULL
          AND audit.chain_sequence IS DISTINCT FROM resolved.chain_sequence
      ) AS sequence_mismatch_count
    FROM audit_logs audit
    LEFT JOIN resolved_audit_chain resolved ON resolved.id = audit.id
    WHERE audit.event_hash IS NOT NULL
  `) as ResolutionCounts[];
  assertNoViolations("unresolved cycle event(s)", {
    violation_count: counts?.unresolved_count || 0,
  });
  assertNoViolations("existing sequence mismatch(es)", {
    violation_count: counts?.sequence_mismatch_count || 0,
  });
}

async function backfillMissingSequences(transaction: SQL): Promise<void> {
  await transaction.unsafe("DROP TRIGGER IF EXISTS audit_logs_append_only ON audit_logs");
  await transaction.unsafe(`
    ${AUDIT_CHAIN_RESOLUTION_CTE}
    UPDATE audit_logs audit
    SET chain_sequence = resolved.chain_sequence
    FROM resolved_audit_chain resolved
    WHERE audit.id = resolved.id AND audit.chain_sequence IS NULL
  `);
}

async function assertCheckpointCompatibility(transaction: SQL): Promise<void> {
  const [violation] = await transaction.unsafe(`
    ${AUDIT_CHAIN_HEADS_CTE}
    SELECT count(*) AS violation_count
    FROM audit_log_checkpoints checkpoint
    FULL OUTER JOIN audit_chain_heads head ON head.project_key = checkpoint.project_ref
    WHERE (
      head.project_key IS NULL
      AND (checkpoint.event_count <> 0 OR checkpoint.last_event_id IS NOT NULL OR checkpoint.last_event_hash IS NOT NULL)
    ) OR (
      head.project_key IS NOT NULL
      AND checkpoint.project_ref IS NOT NULL
      AND (
        checkpoint.event_count IS DISTINCT FROM head.event_count
        OR checkpoint.last_event_id IS DISTINCT FROM head.last_event_id
        OR checkpoint.last_event_hash IS DISTINCT FROM head.last_event_hash
      )
    )
  `) as ViolationCount[];
  assertNoViolations("checkpoint mismatch(es)", violation);
}

async function createMissingCheckpoints(transaction: SQL): Promise<void> {
  await transaction.unsafe(`
    ${AUDIT_CHAIN_HEADS_CTE}
    INSERT INTO audit_log_checkpoints (
      project_ref, last_event_id, last_event_hash, event_count, updated_at
    )
    SELECT project_key, last_event_id, last_event_hash, event_count, NOW()
    FROM audit_chain_heads
    ON CONFLICT (project_ref) DO NOTHING
  `);
}

async function assertFinalContinuity(transaction: SQL): Promise<void> {
  const [violation] = await transaction<ViolationCount[]>`
    SELECT count(*) AS violation_count
    FROM audit_logs child
    LEFT JOIN audit_logs parent
      ON parent.project_ref IS NOT DISTINCT FROM child.project_ref
     AND parent.event_hash = child.previous_hash
    WHERE child.event_hash IS NOT NULL
      AND (
        child.chain_sequence IS NULL
        OR (child.previous_hash IS NULL AND child.chain_sequence <> 1)
        OR (child.previous_hash IS NOT NULL AND child.chain_sequence <> parent.chain_sequence + 1)
      )
  `;
  assertNoViolations("final continuity mismatch(es)", violation);
}

async function finalizeAuditChainSchema(transaction: SQL): Promise<void> {
  await transaction.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_chain_sequence_unique_idx
      ON audit_logs(project_ref, chain_sequence) NULLS NOT DISTINCT
      WHERE event_hash IS NOT NULL
  `);
  await transaction.unsafe(`
    CREATE TRIGGER audit_logs_append_only
      BEFORE UPDATE OR DELETE ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation()
  `);
}

async function recordMigrationMarker(transaction: SQL): Promise<void> {
  const [summary] = await transaction<MigrationSummary[]>`
    SELECT
      count(*) AS hashed_event_count,
      count(DISTINCT COALESCE(project_ref, '__platform__')) AS project_chain_count
    FROM audit_logs
    WHERE event_hash IS NOT NULL
  `;
  const details = JSON.stringify({
    hashed_event_count: Number(summary?.hashed_event_count || 0),
    project_chain_count: Number(summary?.project_chain_count || 0),
  });
  await transaction`
    INSERT INTO platform_schema_migrations (migration_key, details)
    VALUES (${AUDIT_CHAIN_SEQUENCE_MIGRATION_KEY}, ${details}::jsonb)
  `;
}

export async function migrateAuditChainSequences(transaction: SQL): Promise<void> {
  await acquireAuditChainMigrationLock(transaction);
  if (await migrationIsCompleted(transaction)) return;

  await assertNoDuplicateHashes(transaction);
  await assertNoBranches(transaction);
  await assertNoOrphans(transaction);
  await assertOneRootPerChain(transaction);
  await createAuditChainIndexes(transaction);
  await assertResolutionIsComplete(transaction);
  await backfillMissingSequences(transaction);
  await createMissingCheckpoints(transaction);
  await assertFinalContinuity(transaction);
  await assertCheckpointCompatibility(transaction);
  await finalizeAuditChainSchema(transaction);
  await recordMigrationMarker(transaction);
}

export async function assertPlatformMigrationCompleted(database: SQL): Promise<void> {
  if (await migrationIsCompleted(database)) return;
  throw new PlatformMigrationRequiredError();
}
