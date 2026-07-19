import { createHash, randomBytes } from "node:crypto";

type ProjectSql = ReturnType<(typeof import("../db"))["getProjectDb"]>;

export interface MigrationLedgerLease {
  token: string;
  tokenHash: string;
}

function createLease(): MigrationLedgerLease {
  const token = randomBytes(32).toString("hex");
  return {
    token,
    tokenHash: createHash("sha256").update(token).digest("hex"),
  };
}

export async function issueMigrationLedgerLease(
  adminDb: ProjectSql,
  version: string,
  checksum: string,
): Promise<MigrationLedgerLease> {
  const lease = createLease();
  await adminDb`
    DELETE FROM supabase_migrations.migration_ledger_leases
    WHERE expires_at <= clock_timestamp()
  `;
  await adminDb`
    INSERT INTO supabase_migrations.migration_ledger_leases
      (token_hash, version, checksum, expires_at)
    VALUES
      (${lease.tokenHash}, ${version}, ${checksum}, clock_timestamp() + interval '5 minutes')
  `;
  return lease;
}

export async function releaseMigrationLedgerLease(
  adminDb: ProjectSql,
  tokenHash: string,
): Promise<void> {
  await adminDb`
    DELETE FROM supabase_migrations.migration_ledger_leases
    WHERE token_hash = ${tokenHash}
  `;
}
