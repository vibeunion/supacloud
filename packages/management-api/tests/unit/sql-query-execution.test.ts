import { describe, expect, test } from "bun:test";
import {
  assertSqlExecutionAllowed,
  executeQuery,
  PgError,
  sqlExecutionError,
} from "../../src/db";

describe("SQL query execution policy", () => {
  test("returns a stable error for multiple read-mode SQL statements", () => {
    try {
      assertSqlExecutionAllowed("SELECT 1; SELECT 2;", "read");
      throw new Error("expected multiple statements to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(PgError);
      expect((error as PgError).code).toBe("MULTIPLE_SQL_STATEMENTS_NOT_SUPPORTED");
      expect((error as PgError).message).toBe(
        "SQL editor supports one statement at a time. Run each statement separately.",
      );
    }
  });

  test("keeps migration and admin multi-statement behavior unchanged", () => {
    expect(() => assertSqlExecutionAllowed("SELECT 1; SELECT 2;", "migration")).not.toThrow();
    expect(() => assertSqlExecutionAllowed("SELECT 1; SELECT 2;", "admin")).not.toThrow();
  });

  test("allows semicolons inside a single read-mode SQL statement", () => {
    const singleStatements = [
      "SELECT ';' AS punctuation;",
      "SELECT \"semi;colon\" FROM demo;",
      "SELECT $$body;with;semicolons$$;",
      "SELECT 1; -- trailing comment with ;\n",
    ];

    for (const sql of singleStatements) {
      expect(() => assertSqlExecutionAllowed(sql, "read")).not.toThrow();
    }
  });

  test("normalizes only registry-confirmed cancellation errors", () => {
    expect(sqlExecutionError(
      Object.assign(new Error("Query cancelled"), { code: "QUERY_CANCELLED" }),
      28,
    )).toMatchObject({
      message: "Query cancelled",
      code: "QUERY_CANCELLED",
      durationMs: 28,
    });
  });

  test("reports PostgreSQL statement timeout separately from user cancellation", () => {
    const timeout = sqlExecutionError(Object.assign(
      new Error("canceling statement due to statement timeout"),
      { code: "ERR_POSTGRES_SERVER_ERROR", errno: "57014" },
    ), 30_001);
    expect(timeout).toMatchObject({
      message: "Query timed out",
      code: "QUERY_TIMEOUT",
      durationMs: 30_001,
    });

    const externalInterruption = sqlExecutionError(Object.assign(
      new Error("canceling statement due to user request"),
      { code: "ERR_POSTGRES_SERVER_ERROR", errno: "57014" },
    ), 14);
    expect(externalInterruption).toMatchObject({
      message: "canceling statement due to user request",
      code: "ERR_POSTGRES_SERVER_ERROR",
      durationMs: 14,
    });
  });

  test("requires an explicit project scope for cancellable queries", async () => {
    await expect(executeQuery("unused_db", "SELECT 1", {
      queryId: "query-id-123456789",
    })).rejects.toMatchObject({
      code: "SQL_QUERY_PROJECT_SCOPE_REQUIRED",
    });
  });
});
