import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  issueMigrationLedgerLease,
  releaseMigrationLedgerLease,
} from "../../src/services/migration-ledger-lease";

describe("migration ledger lease", () => {
  test("issues a short-lived random lease through parameterized admin SQL", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const adminDb = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join("?"), values });
      return Promise.resolve([]);
    }) as never;

    const lease = await issueMigrationLedgerLease(adminDb, "202607180001", "checksum");
    await releaseMigrationLedgerLease(adminDb, lease.tokenHash);

    expect(lease.token).toHaveLength(64);
    expect(lease.tokenHash).toBe(createHash("sha256").update(lease.token).digest("hex"));
    expect(calls).toHaveLength(3);
    expect(calls[1]?.sql).toContain("INSERT INTO supabase_migrations.migration_ledger_leases");
    expect(calls[1]?.values).toEqual(expect.arrayContaining([
      lease.tokenHash,
      "202607180001",
      "checksum",
    ]));
    expect(calls.map((call) => call.sql).join("\n")).not.toContain(lease.token);
  });
});
