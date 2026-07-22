import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  ensureMigrationTables,
  ensureTasksRealtimePublication,
  buildCreateMaterializedViewSql,
  buildDropMaterializedViewSql,
  buildRefreshMaterializedViewSql,
  migrationExecutionStatements,
  MIGRATION_SESSION_RESET_SQL,
  migrationExecutionStatements,
  migrationLedgerEntryMatches,
  normalizeMigrationVersion,
  resetEnsuredMigrationTablesForTests,
  resolveMigrationStatements,
  sqlRouteResponse,
} from "../../src/routes/database";
import { projectMigrationSqlViolations } from "../../src/db/sql-policy";
import { calculateMigrationChecksum } from "../../src/services/migration-promotion";

describe("database route helpers", () => {
  beforeEach(() => {
    resetEnsuredMigrationTablesForTests();
  });

  test("extracts a single statement from cli query format", () => {
    expect(
      resolveMigrationStatements({
        query: "create table demo(id int primary key);",
      }),
    ).toEqual(["create table demo(id int primary key);"]);
  });

  test("prefers explicit structured statements over joined sql", () => {
    expect(
      resolveMigrationStatements({
        name: "demo",
        sql: "select 1;",
        statements: ["alter table demo add column name text;", "select 1;"],
      }),
    ).toEqual([
      "alter table demo add column name text;",
      "select 1;",
    ]);
  });

  test("returns empty list when migration body has no executable SQL", () => {
    expect(
      resolveMigrationStatements({
        name: "empty",
        statements: [],
      }),
    ).toEqual([]);
    expect(resolveMigrationStatements({ query: "   " })).toEqual([]);
  });

  test("removes only an outer transaction wrapper before execution", () => {
    const wrappedFile = ["BEGIN;", "CREATE TABLE public.example(id integer);", "COMMIT;"];
    expect(migrationExecutionStatements(wrappedFile)).toEqual([
      "CREATE TABLE public.example(id integer)",
    ]);
    expect(migrationExecutionStatements(["BEGIN;\nCREATE TABLE public.example(id integer);\nCOMMIT;"]))
      .toEqual(["CREATE TABLE public.example(id integer)"]);
    expect(migrationExecutionStatements([
      "-- generated migration\nBEGIN TRANSACTION;\nCREATE TABLE public.example(id integer);\nCOMMIT WORK;",
    ])).toEqual(["CREATE TABLE public.example(id integer)"]);

    const wrappedDoBlock = ["BEGIN;", "DO $$ BEGIN PERFORM 1; END $$;", "COMMIT;"];
    expect(migrationExecutionStatements(wrappedDoBlock)).toEqual([
      "DO $$ BEGIN PERFORM 1; END $$",
    ]);
    expect(projectMigrationSqlViolations(migrationExecutionStatements(wrappedFile)))
      .not.toContain("transaction control");
    expect(projectMigrationSqlViolations(migrationExecutionStatements(wrappedDoBlock)))
      .not.toContain("transaction control");
    expect(projectMigrationSqlViolations(migrationExecutionStatements(wrappedDoBlock)))
      .toContain("opaque procedural SQL");
  });

  test("derives xigu-style function execution without changing ledger input", () => {
    const wrappedSql = `
      BEGIN;
      CREATE OR REPLACE FUNCTION public.fa_case_member_role_compatibility_guard()
      RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
      BEGIN
        IF NEW.membership_id IS NULL THEN
          RAISE EXCEPTION 'FA_CASE_MEMBER_REQUIRED';
        END IF;
        RETURN NEW;
      END;
      $function$;
      GRANT EXECUTE ON FUNCTION public.fa_case_member_role_compatibility_guard() TO service_role;
      COMMIT;
    `.trim();
    const originalStatements = [wrappedSql];
    const executionStatements = migrationExecutionStatements(originalStatements);

    expect(executionStatements).toHaveLength(2);
    expect(executionStatements[0]).toContain("BEGIN\n        IF NEW.membership_id IS NULL");
    expect(executionStatements[0]).toContain("END;\n      $function$");
    expect(executionStatements[1]).toStartWith("GRANT EXECUTE ON FUNCTION");
    expect(originalStatements).toEqual([wrappedSql]);
    expect(calculateMigrationChecksum({ version: "20260719126000", name: "xigu", statements: originalStatements }))
      .not.toBe(calculateMigrationChecksum({ version: "20260719126000", name: "xigu", statements: executionStatements }));
  });

  test("rejects migrations that are empty after execution derivation", () => {
    expect(() => migrationExecutionStatements(["BEGIN; COMMIT;"]))
      .toThrow("Migration contains no executable statements");
    expect(() => migrationExecutionStatements(["BEGIN; -- no statements\nCOMMIT;"]))
      .toThrow("Migration contains no executable statements");
    expect(() => migrationExecutionStatements(["-- comment only"]))
      .toThrow("Migration contains no executable statements");
  });

  test("checks existing checksums before applying the current SQL policy", () => {
    const source = readFileSync(join(import.meta.dirname, "../../src/routes/database.ts"), "utf8");
    const transactionStart = source.indexOf("async function executeMigrationTransaction(");
    const transactionEnd = source.indexOf("async function withMigrationRoleSession", transactionStart);
    const transactionSource = source.slice(transactionStart, transactionEnd);
    const existingLookup = transactionSource.indexOf("findExistingMigration(tx, input)");
    const checksumCheck = transactionSource.indexOf("existingMigrationChecksum(existing[0]!, input)");
    const checksumConflict = transactionSource.indexOf('"migration_checksum_conflict"');
    const alreadyAppliedReturn = transactionSource.indexOf("return true;");
    const policyCheck = transactionSource.indexOf("detectUnsupportedMigrationOperations(execution.statements)");

    expect(existingLookup).toBeGreaterThan(-1);
    expect(checksumCheck).toBeGreaterThan(existingLookup);
    expect(checksumConflict).toBeGreaterThan(checksumCheck);
    expect(alreadyAppliedReturn).toBeGreaterThan(checksumConflict);
    expect(policyCheck).toBeGreaterThan(alreadyAppliedReturn);
  });

  test("accepts exact legacy ledger SQL when its stored checksum uses the raw file format", () => {
    const input = {
      version: "20260720111000",
      name: "20260720111000_accept_linked_rework_case_on_scope_approval",
      statements: ["CREATE FUNCTION demo() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;\n"],
    };
    expect(migrationLedgerEntryMatches({
      version: input.version,
      name: input.name,
      checksum: "raw-file-sha256",
      statements: ["CREATE FUNCTION demo() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;"],
    }, input)).toBe(true);
    expect(migrationLedgerEntryMatches({
      version: input.version,
      name: "different-name",
      checksum: "raw-file-sha256",
      statements: input.statements,
    }, input)).toBe(false);
    expect(migrationLedgerEntryMatches({
      version: input.version,
      name: input.name,
      checksum: "raw-file-sha256",
      statements: ["CREATE FUNCTION demo() RETURNS void LANGUAGE sql AS $$ SELECT 2 $$;"],
    }, input)).toBe(false);
  });

  test("resets migration sessions without deallocating pooled prepared statements", () => {
    expect(MIGRATION_SESSION_RESET_SQL).toBe("RESET ALL; DISCARD TEMP; DISCARD PLANS");
    expect(MIGRATION_SESSION_RESET_SQL).not.toContain("DISCARD ALL");
  });

  test("does not let quoted dollar markers hide top-level policy controls", () => {
    const adversarialCases: Array<[string, string]> = [
      ["SELECT '$$'; COMMIT; SELECT $$x$$;", "transaction control"],
      ["SELECT '$$'; SET ROLE postgres; SELECT $$x$$;", "session role control"],
      [
        "SELECT '$$'; INSERT INTO supabase_migrations.schema_migrations(version) VALUES ('1'); SELECT $$x$$;",
        "migration ledger modification",
      ],
      ["SELECT '$$'; SELECT pg_advisory_lock(1); SELECT $$x$$;", "advisory lock control"],
      ["SELECT '$$'; DO $$ BEGIN PERFORM 1; END $$;", "opaque procedural SQL"],
    ];

    for (const [sql, expectedViolation] of adversarialCases) {
      expect(projectMigrationSqlViolations(migrationExecutionStatements([sql])))
        .toContain(expectedViolation);
    }
  });

  test("preserves bigint migration versions without Number precision loss", () => {
    expect(normalizeMigrationVersion("20260718000123")).toBe("20260718000123");
    expect(normalizeMigrationVersion("0001")).toBe("1");
    expect(() => normalizeMigrationVersion("9223372036854775808")).toThrow("outside");
    expect(() => normalizeMigrationVersion(Number.MAX_SAFE_INTEGER + 1)).toThrow("bigint");
  });

  test("ensures migration tables only once per database", async () => {
    const calls: string[] = [];
    const projectDb = (() => Promise.resolve([])) as any;
    projectDb.unsafe = (sql: string) => {
      calls.push(sql);
      return Promise.resolve([]);
    };

    await ensureMigrationTables("db1", projectDb);
    await ensureMigrationTables("db1", projectDb);

    expect(calls.filter((sql) => sql.includes("CREATE TABLE IF NOT EXISTS")).length).toBe(2);
    expect(calls.filter((sql) => sql.includes("INSERT INTO supabase_migrations.schema_migrations")).length).toBe(2);
    expect(calls.some((sql) => sql.includes("version TEXT PRIMARY KEY"))).toBe(true);
  });

  test("ensures metadata columns and reconciles both ledger tables", async () => {
    const calls: string[] = [];
    const projectDb = (() => Promise.resolve([])) as any;
    projectDb.unsafe = (sql: string) => {
      calls.push(sql);
      return Promise.resolve([]);
    };

    await ensureMigrationTables("db2", projectDb);

    expect(calls.some((sql) => sql.includes("CREATE SCHEMA IF NOT EXISTS supabase_migrations"))).toBe(true);
    expect(calls.filter((sql) => sql.includes("CREATE TABLE IF NOT EXISTS")).length).toBe(2);
    expect(calls.some((sql) => sql.includes("supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS checksum"))).toBe(true);
    expect(calls.some((sql) => sql.includes("public.schema_migrations ADD COLUMN IF NOT EXISTS inserted_at"))).toBe(true);
    expect(calls.some((sql) => sql.includes("FROM public.schema_migrations"))).toBe(true);
    expect(calls.some((sql) => sql.includes("FROM supabase_migrations.schema_migrations"))).toBe(true);
  });

  test("sqlRouteResponse returns stable SQL shape without legacy aliases", () => {
    const response = sqlRouteResponse({
      rows: [{ ok: 1 }],
      rowCount: 1,
      command: "SELECT",
      fields: ["ok"],
      notices: [],
    });

    expect(response).toEqual({
      rows: [{ ok: 1 }],
      rowCount: 1,
      command: "SELECT",
      fields: ["ok"],
      notices: [],
    });
  });

  test("builds safe materialized view SQL", () => {
    expect(
      buildCreateMaterializedViewSql({
        schema: "public",
        name: "orders_daily",
        definition: "select date_trunc('day', created_at) as day, count(*) from orders group by 1;",
        withData: false,
      }),
    ).toBe(
      `CREATE MATERIALIZED VIEW "public"."orders_daily" AS select date_trunc('day', created_at) as day, count(*) from orders group by 1 WITH NO DATA`,
    );

    expect(
      buildRefreshMaterializedViewSql({
        schema: "public",
        name: "orders_daily",
        concurrently: true,
      }),
    ).toBe(`REFRESH MATERIALIZED VIEW CONCURRENTLY "public"."orders_daily"`);

    expect(
      buildDropMaterializedViewSql({
        schema: "public",
        name: "orders_daily",
        ifExists: true,
      }),
    ).toBe(`DROP MATERIALIZED VIEW IF EXISTS "public"."orders_daily"`);
  });

  test("rejects unsafe materialized view definitions and identifiers", () => {
    expect(() =>
      buildCreateMaterializedViewSql({
        name: "bad-name",
        definition: "select 1",
      }),
    ).toThrow("identifier");

    expect(() =>
      buildCreateMaterializedViewSql({
        name: "ok_name",
        definition: "select 1; drop table users",
      }),
    ).toThrow("single query");

    expect(() =>
      buildCreateMaterializedViewSql({
        name: "ok_name",
        definition: "delete from users",
      }),
    ).toThrow("SELECT or WITH");
  });

  test("ensureTasksRealtimePublication invokes helper when available", async () => {
    const calls: string[] = [];
    const projectDb = ((strings: TemplateStringsArray) => {
      calls.push(strings.join("?"));
      return Promise.resolve([]);
    }) as any;

    await ensureTasksRealtimePublication(projectDb);

    expect(calls).toEqual(["SELECT realtime.ensure_tasks_publication()"]);
  });

  test("ensureTasksRealtimePublication is non-fatal for older tenants", async () => {
    const projectDb = (() => Promise.reject(new Error("schema realtime does not exist"))) as any;

    await expect(ensureTasksRealtimePublication(projectDb)).resolves.toBeUndefined();
  });

  test("tenant bootstrap and reconcile scripts publish public.tasks for realtime", () => {
    const root = join(import.meta.dirname, "../..");
    const files = [
      "src/scripts/migrate-tenant-schema.ts",
      "src/db/schemas/supabase.sql",
      "scripts/reconcile-realtime-schema-privileges.ts",
    ];

    for (const file of files) {
      const contents = readFileSync(join(root, file), "utf8");
      expect(contents).toContain("ALTER TABLE public.tasks REPLICA IDENTITY FULL");
      expect(contents).toContain("ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks");
    }
  });
});
