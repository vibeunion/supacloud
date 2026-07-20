import { describe, expect, test } from "bun:test";
import { executeSqlStatements, splitSqlStatements } from "../../src/db/sql-statements";

describe("PostgreSQL statement splitter", () => {
  test("keeps quoted literals, comments, and dollar-quoted bodies intact", () => {
    const statements = splitSqlStatements(`
      -- semicolon ; in a line comment
      CREATE FUNCTION public.fixture_fn() RETURNS text AS $fn$
      BEGIN
        PERFORM E'escaped\\';semicolon';
        PERFORM 'single;quoted';
        /* nested ; comment /* still comment ; */ */
        RETURN 'body;value';
      END;
      $fn$ LANGUAGE plpgsql;
      CREATE TABLE "table;name" (value text DEFAULT 'default;value');
      SELECT $$dollar;quoted$$;
    `);

    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain("$fn$");
    expect(statements[0]).toContain("escaped\\';semicolon");
    expect(statements[1]).toContain('"table;name"');
    expect(statements[2]).toContain("$$dollar;quoted$$");
  });

  test("rejects unterminated SQL constructs", () => {
    expect(() => splitSqlStatements("SELECT 'unterminated;")).toThrow(/Unterminated SQL/);
    expect(() => splitSqlStatements("SELECT $$unterminated;")).toThrow(/Unterminated SQL/);
    expect(() => splitSqlStatements("/* unterminated;")).toThrow(/Unterminated SQL/);
  });

  test("accepts a line comment at end of input", () => {
    expect(splitSqlStatements("SELECT 1; -- trailing comment")).toEqual(["SELECT 1"]);
  });

  test("does not treat backslashes as escapes in standard strings", () => {
    expect(splitSqlStatements("SELECT '\\'; SELECT 2;")).toEqual(["SELECT '\\'", "SELECT 2"]);
  });

  test("keeps escaped quotes and semicolons inside escape strings", () => {
    const statements = splitSqlStatements(String.raw`SELECT E'escaped\';semicolon'; SELECT 2;`);

    expect(statements).toEqual([String.raw`SELECT E'escaped\';semicolon'`, "SELECT 2"]);
  });

  test("executes statements on the caller-owned transaction and stops after failure", async () => {
    const calls: string[] = [];
    const transaction = {
      unsafe: async (statement: string) => {
        calls.push(statement);
        if (statement.includes("FAIL")) throw new Error("fixture failure");
      },
    } as never;

    await expect(executeSqlStatements(transaction, "SELECT 1; SELECT FAIL; SELECT 3;")).rejects.toThrow("fixture failure");
    expect(calls).toHaveLength(2);
  });
});
