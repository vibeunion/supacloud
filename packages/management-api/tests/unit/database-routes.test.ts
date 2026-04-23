import { describe, expect, test } from "bun:test";
import { resolveMigrationStatements } from "../../src/routes/database";

describe("database route helpers", () => {
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
});
