import { describe, expect, test } from "bun:test";
import { assertPolicyAllows, assertPolicyDenies, runSqlTests } from "./db";
import type { SqlExecutor } from "./db";

interface Call {
  sql: string;
  params?: unknown[];
}

/**
 * Fake executor: statements containing FAIL throw insufficient_privilege,
 * statements containing EMPTY return no rows, everything else returns one row.
 */
function createFakeExecutor(): { executor: SqlExecutor; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    executor: {
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        calls.push({ sql, params });
        if (sql.includes("FAIL")) {
          const error = new Error("permission denied for table cases");
          (error as { code?: string }).code = "42501"; // insufficient_privilege
          throw error;
        }
        if (sql.includes("EMPTY")) {
          return [];
        }
        return [{ id: 1 }] as T[];
      },
    },
  };
}

const SQL_FILE = [
  "-- @test insert a case",
  "INSERT INTO cases (title) VALUES ('a');",
  "-- @test insert fails without permission",
  "-- @expect error",
  "INSERT INTO cases (title) VALUES ('FAIL');",
].join("\n");

async function readVirtual(path: string): Promise<string> {
  if (path === "cases.test.sql") return SQL_FILE;
  throw new Error(`unknown file: ${path}`);
}

describe("runSqlTests", () => {
  test("splits files into @test segments and wraps each in a transaction", async () => {
    const { executor, calls } = createFakeExecutor();
    const results = await runSqlTests(executor, ["cases.test.sql"], readVirtual);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ file: "cases.test.sql", name: "insert a case", passed: true });
    expect(results[1]).toMatchObject({
      file: "cases.test.sql",
      name: "insert fails without permission",
      passed: true,
    });

    // Each segment is wrapped in BEGIN ... ROLLBACK.
    expect(calls.map((c) => c.sql)).toEqual([
      "BEGIN",
      "INSERT INTO cases (title) VALUES ('a');\n",
      "ROLLBACK",
      "BEGIN",
      "INSERT INTO cases (title) VALUES ('FAIL');\n",
      "ROLLBACK",
    ]);
  });

  test("fails a segment that throws unexpectedly", async () => {
    const { executor } = createFakeExecutor();
    const read = async () => "-- @test boom\nFAIL;\n";
    const results = await runSqlTests(executor, ["x.sql"], read);
    expect(results[0].passed).toBe(false);
    expect(results[0].error).toContain("permission denied");
  });

  test("fails an @expect error segment that succeeds", async () => {
    const { executor } = createFakeExecutor();
    const read = async () => "-- @test should fail\n-- @expect error\nSELECT 1;\n";
    const results = await runSqlTests(executor, ["x.sql"], read);
    expect(results[0].passed).toBe(false);
    expect(results[0].error).toContain("expected an error");
  });
});

describe("assertPolicyAllows", () => {
  test("passes when the query succeeds", async () => {
    const { executor } = createFakeExecutor();
    await assertPolicyAllows(executor, "SELECT * FROM cases;");
  });

  test("fails when the query throws", async () => {
    const { executor } = createFakeExecutor();
    await expect(assertPolicyAllows(executor, "FAIL")).rejects.toThrow(/expected the statement to be allowed/);
  });
});

describe("assertPolicyDenies", () => {
  test("passes when the query throws a permission error", async () => {
    const { executor } = createFakeExecutor();
    await assertPolicyDenies(executor, "FAIL");
  });

  test("passes when RLS silently filters all rows", async () => {
    const { executor } = createFakeExecutor();
    await assertPolicyDenies(executor, "SELECT EMPTY FROM cases;");
  });

  test("fails when rows come back", async () => {
    const { executor } = createFakeExecutor();
    await expect(assertPolicyDenies(executor, "SELECT * FROM cases;")).rejects.toThrow(
      /returned 1 row/,
    );
  });
});
