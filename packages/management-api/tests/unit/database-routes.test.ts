import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  ensureMigrationTables,
  ensureTasksRealtimePublication,
  buildCreateMaterializedViewSql,
  buildDropMaterializedViewSql,
  buildRefreshMaterializedViewSql,
  resetEnsuredMigrationTablesForTests,
  resolveMigrationStatements,
  sqlRouteResponse,
} from "../../src/routes/database";

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
  });

  test("ensures migration tables only once per database", async () => {
    const calls: string[] = [];
    const projectDb = ((strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      calls.push(sql);
      if (sql.includes("SELECT EXISTS")) return Promise.resolve([{ exists: false }]);
      return Promise.resolve([]);
    }) as any;
    projectDb.unsafe = (sql: string) => {
      calls.push(sql);
      return Promise.resolve([]);
    };

    await ensureMigrationTables("db1", projectDb);
    await ensureMigrationTables("db1", projectDb);

    expect(calls.filter((sql) => sql.includes("CREATE TABLE IF NOT EXISTS")).length).toBe(2);
    expect(calls.filter((sql) => sql.includes("SELECT EXISTS")).length).toBe(1);
  });

  test("skips supabase migration DDL when table already exists", async () => {
    const calls: string[] = [];
    const projectDb = ((strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      calls.push(sql);
      if (sql.includes("SELECT EXISTS")) return Promise.resolve([{ exists: true }]);
      return Promise.resolve([]);
    }) as any;
    projectDb.unsafe = (sql: string) => {
      calls.push(sql);
      return Promise.resolve([]);
    };

    await ensureMigrationTables("db2", projectDb);

    expect(calls.some((sql) => sql.includes("CREATE SCHEMA IF NOT EXISTS supabase_migrations"))).toBe(false);
    expect(calls.filter((sql) => sql.includes("CREATE TABLE IF NOT EXISTS")).length).toBe(1);
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
