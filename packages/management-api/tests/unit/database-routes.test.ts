import { beforeEach, describe, expect, test } from "bun:test";
import { ensureMigrationTables, resetEnsuredMigrationTablesForTests, resolveMigrationStatements, sqlRouteResponse } from "../../src/routes/database";

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

  test("sqlRouteResponse keeps stable shape and legacy result field", () => {
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
      result: [{ ok: 1 }],
    });
  });
});
