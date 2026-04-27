import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  ensureMigrationTables,
  ensureTasksRealtimePublication,
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
