import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { ensureUsageMeterSchema, USAGE_METER_SCHEMA_SQL } from "../../src/db/usage-meter-schema";
import { splitSqlStatements } from "../../src/db/sql-statements";

test("usage ledger sql records quantities and keeps receipts append-only", async () => {
  const statements = splitSqlStatements(USAGE_METER_SCHEMA_SQL);
  expect(statements.length).toBeGreaterThan(3);
  for (const statement of statements) expect(splitSqlStatements(statement)).toHaveLength(1);

  const sql = statements.join("\n");
  expect(sql).toContain("usage_receipts is append-only");
  expect(sql).toContain("cpu_milliseconds");
  expect(sql).toContain("storage_bytes");
  expect(sql).toContain("function_invocations");
  expect(sql).toContain("USAGE_OBSERVATION_CONFLICT");
  expect(sql).not.toMatch(/price|invoice|currency|stripe|payment/i);

  const executed: string[] = [];
  const transaction = Object.assign(async () => [], {
    unsafe: async (statement: string) => {
      executed.push(statement);
    },
  }) as unknown as SQL;
  await ensureUsageMeterSchema(transaction);
  expect(executed).toEqual(statements);
});
