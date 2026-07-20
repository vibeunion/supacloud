import type { SQL } from "bun";

export const AUDIT_CHAIN_SEQUENCE_MIGRATION_KEY = "20260720_audit_chain_sequences_v1";

const AUDIT_CHAIN_MIGRATION_LOCK_KEY = `platform-schema:${AUDIT_CHAIN_SEQUENCE_MIGRATION_KEY}`;

export async function acquireAuditChainAppendLock(transaction: SQL): Promise<void> {
  await transaction`
    SELECT pg_advisory_xact_lock_shared(hashtextextended(${AUDIT_CHAIN_MIGRATION_LOCK_KEY}, 0))
  `;
}

export async function acquireAuditChainMigrationLock(transaction: SQL): Promise<void> {
  await transaction`
    SELECT pg_advisory_xact_lock(hashtextextended(${AUDIT_CHAIN_MIGRATION_LOCK_KEY}, 0))
  `;
}
