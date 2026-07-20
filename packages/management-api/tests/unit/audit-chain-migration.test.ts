import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import {
  AUDIT_CHAIN_SEQUENCE_MIGRATION_KEY,
  assertPlatformMigrationCompleted,
  migrateAuditChainSequences,
  PlatformMigrationRequiredError,
} from "../../src/db/audit-chain-migration";

type QueryCall = { query: string; parameters: unknown[] };

function markerDatabase(markerExists: boolean): { database: SQL; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const database = Object.assign(
    async (strings: TemplateStringsArray, ...parameters: unknown[]) => {
      const query = strings.join("?");
      calls.push({ query, parameters });
      if (query.includes("FROM platform_schema_migrations")) {
        return markerExists ? [{ migration_key: AUDIT_CHAIN_SEQUENCE_MIGRATION_KEY }] : [];
      }
      return [];
    },
    {
      unsafe: async () => {
        throw new Error("marker fast path must not execute unsafe SQL");
      },
    },
  ) as unknown as SQL;
  return { database, calls };
}

describe("audit chain platform migration gate", () => {
  test("fails fast with one marker lookup when the migration is missing", async () => {
    const fixture = markerDatabase(false);

    await expect(assertPlatformMigrationCompleted(fixture.database))
      .rejects.toBeInstanceOf(PlatformMigrationRequiredError);
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.query).toContain("WHERE migration_key = ?");
    expect(fixture.calls[0]?.query).not.toContain("audit_logs");
  });

  test("passes with one marker lookup when the migration is complete", async () => {
    const fixture = markerDatabase(true);

    await assertPlatformMigrationCompleted(fixture.database);
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.parameters).toEqual([AUDIT_CHAIN_SEQUENCE_MIGRATION_KEY]);
  });

  test("returns after the advisory lock and marker lookup on repeat init", async () => {
    const fixture = markerDatabase(true);

    await migrateAuditChainSequences(fixture.database);
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls[0]?.query).toContain("pg_advisory_xact_lock");
    expect(fixture.calls[0]?.query).not.toContain("pg_advisory_xact_lock_shared");
    expect(fixture.calls[1]?.query).toContain("FROM platform_schema_migrations");
  });
});
