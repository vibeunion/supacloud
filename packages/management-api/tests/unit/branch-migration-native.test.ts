// @supacloud-test-isolate
import { expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { branchService } from "../../src/services/branch.service";
import { ensureMigrationLedgerMetadata } from "../../src/services/migration-ledger";
import { createMigrationLedgerEntry } from "../../src/services/migration-promotion";
import { prepareProjectMigrationRole } from "../../src/services/project-migration-role";
import * as notifications from "../../src/services/database-schema-notify";
import { withPostgresDatabase } from "../../src/utils/postgres-url";
import { withNativePostgres } from "../helpers/native-postgres";
import { observeNativeNotifications } from "../helpers/native-pg-notifications";

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
  "native branch migrations commit ledger and notifications together and roll back failures",
  async () => withNativePostgres(async (database, url) => {
    await database.unsafe(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
      CREATE ROLE migration_fixture LOGIN PASSWORD 'synthetic';
    `);
    await ensureMigrationLedgerMetadata(database);
    await prepareProjectMigrationRole(database, "fixture", "migration_fixture");
    const migration = new SQL(withPostgresDatabase(url, "fixture", "migration_fixture", "synthetic"), { max: 1 });
    const observer = await observeNativeNotifications(database, url, ["pgrst_parent", "pgrst"]);
    let reserved: Awaited<ReturnType<SQL["reserve"]>> | undefined;
    try {
      const connection = await migration.reserve();
      reserved = connection;
      const role: unknown = await connection`SELECT current_user AS name`;
      expect(role).toEqual([{ name: "migration_fixture" }]);
      const directWrite = async () => await connection`
        INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20260819090000')
      `;
      await expect(directWrite()).rejects.toThrow("permission denied");
      const forgedLease = async () => await connection`
        SELECT supabase_migrations.record_schema_migration(
          '20260819090000', ARRAY['SELECT 1']::text[], 'forged', 'forged-checksum', 'forged-token'
        )
      `;
      await expect(forgedLease()).rejects.toThrow("Invalid or expired migration ledger lease");
      const entry = createMigrationLedgerEntry({
        version: "20260819091000", name: "create_reload_probe",
        statements: ["CREATE TABLE reload_probe(id bigint primary key)"],
      });
      await branchService["applyMigrationEntry"](connection, database, "parent", entry);
      const committed = [
        { channel: "pgrst_parent", payload: "reload schema" },
        { channel: "pgrst", payload: "reload schema" },
      ];
      expect(await observer.drain()).toEqual(committed);
      const canonical: unknown = await database`
        SELECT version::text, statements, checksum FROM supabase_migrations.schema_migrations
      `;
      const legacy: unknown = await database`
        SELECT version::text, statements, checksum FROM public.schema_migrations
      `;
      expect(canonical).toEqual([{ version: entry.version, statements: entry.statements, checksum: entry.checksum }]);
      expect(legacy).toEqual(canonical);
      const created: unknown = await database`SELECT to_regclass('public.reload_probe')::text AS relation`;
      expect(created).toEqual([{ relation: "reload_probe" }]);
      expect(await database`SELECT token_hash FROM supabase_migrations.migration_ledger_leases`).toHaveLength(0);
      await expect(branchService["applyMigrationEntry"](connection, database, "parent", entry))
        .rejects.toMatchObject({ code: "promotion_plan_changed" });
      expect(await observer.drain()).toEqual(committed);

      const rollbackEntry = createMigrationLedgerEntry({
        version: "20260819092000", name: "rollback_probe",
        statements: ["CREATE TABLE rollback_probe(id bigint primary key)"],
      });
      const notify = notifications.notifyPostgrestSchemaReload;
      const failAfterNotify = spyOn(notifications, "notifyPostgrestSchemaReload")
        .mockImplementation(async (transaction, ref) => {
          await notify(transaction, ref);
          throw new Error("abort after queuing notification");
        });
      try {
        await expect(branchService["applyMigrationEntry"](connection, database, "parent", rollbackEntry))
          .rejects.toThrow("abort after queuing notification");
      } finally {
        failAfterNotify.mockRestore();
      }
      expect(await observer.drain()).toEqual(committed);
      const rolledBack: unknown = await database`SELECT to_regclass('public.rollback_probe') AS relation`;
      expect(rolledBack).toEqual([{ relation: null }]);
      expect(await database`
        SELECT version FROM supabase_migrations.schema_migrations WHERE version = ${rollbackEntry.version}
      `).toHaveLength(0);
      expect(await database`
        SELECT version FROM public.schema_migrations WHERE version = ${rollbackEntry.version}
      `).toHaveLength(0);
      expect(await database`SELECT token_hash FROM supabase_migrations.migration_ledger_leases`).toHaveLength(0);
      await branchService["applyMigrationEntry"](connection, database, "parent", rollbackEntry);
      expect(await observer.drain()).toEqual([...committed, ...committed]);
    } finally {
      try {
        reserved?.release();
      } finally {
        try {
          await migration.close({ timeout: 1 });
        } finally {
          await observer.close();
        }
      }
    }
  }),
  40_000,
);
