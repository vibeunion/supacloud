import { describe, expect, test } from "bun:test";
import {
  ensureMigrationLedgerMetadata,
  MigrationLedgerDivergenceError,
  readMigrationLedger,
} from "../../src/services/migration-ledger";

function postgresError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("migration ledger compatibility", () => {
  test("reconciles legacy and canonical versions after adding metadata columns", async () => {
    const calls: string[] = [];
    await ensureMigrationLedgerMetadata({
      unsafe: async (query: string) => {
        calls.push(query);
        return [];
      },
    });

    expect(calls.some((query) => query.includes("ADD COLUMN IF NOT EXISTS statements"))).toBe(true);
    expect(calls.some((query) => query.includes("INSERT INTO supabase_migrations.schema_migrations"))).toBe(true);
    expect(calls.some((query) => query.includes("INSERT INTO public.schema_migrations"))).toBe(true);
  });

  test("uses legacy history when the canonical table exists but is empty", async () => {
    const database = {
      unsafe: async (query: string) => query.includes("supabase_migrations")
        ? []
        : [{ version: "202607180001", name: "create_accounts", statements: ["select 1"], checksum: null, applied_at: null }],
    };

    const ledger = await readMigrationLedger(database);

    expect(ledger.map((entry) => entry.version)).toEqual(["202607180001"]);
  });

  test("falls back to a legacy column shape only for missing metadata columns", async () => {
    const database = {
      unsafe: async (query: string) => {
        if (query.includes("public.schema_migrations")) throw postgresError("42P01", "missing public ledger");
        if (query.includes("checksum, inserted_at")) throw postgresError("42703", "missing checksum");
        return [{ version: "202607180001", name: "create_accounts", statements: ["select 1"], checksum: null, applied_at: null }];
      },
    };

    expect((await readMigrationLedger(database))[0]?.stored_checksum).toBeNull();
  });

  test("fails closed when legacy history contains versions missing from canonical", async () => {
    const database = {
      unsafe: async (query: string) => query.includes("supabase_migrations")
        ? [{ version: "1", name: "one", statements: ["select 1"], checksum: null, applied_at: null }]
        : [
            { version: "1", name: "one", statements: ["select 1"], checksum: null, applied_at: null },
            { version: "2", name: "two", statements: ["select 2"], checksum: null, applied_at: null },
          ],
    };

    await expect(readMigrationLedger(database)).rejects.toBeInstanceOf(MigrationLedgerDivergenceError);
  });

  test("fails closed when canonical and legacy SQL differ for the same version", async () => {
    const database = {
      unsafe: async (query: string) => query.includes("supabase_migrations.schema_migrations")
        ? [{ version: "1", name: "one", statements: ["select 1"], checksum: null, applied_at: null }]
        : [{ version: "1", name: "one", statements: ["select 2"], checksum: null, applied_at: null }],
    };

    await expect(readMigrationLedger(database)).rejects.toMatchObject({
      code: "migration_ledger_diverged",
      conflictingVersions: ["1"],
    });
  });

  test("returns empty only when both ledger tables are genuinely absent", async () => {
    const missing = postgresError("42P01", "relation does not exist");
    const database = { unsafe: async () => { throw missing; } };

    expect(await readMigrationLedger(database)).toEqual([]);
  });

  test("propagates permission and connectivity failures", async () => {
    const permission = postgresError("42501", "permission denied");
    const database = { unsafe: async () => { throw permission; } };

    await expect(readMigrationLedger(database)).rejects.toBe(permission);
  });
});
