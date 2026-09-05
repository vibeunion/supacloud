/**
 * SQL test runner and RLS assertion helpers.
 *
 * The executor is structural: anything with a query(sql, params) method
 * (postgres.js, pg, an in-memory fake) satisfies it.
 */

export interface SqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface SqlTestResult {
  file: string;
  name: string;
  passed: boolean;
  error?: string;
}

interface SqlTestCase {
  name: string;
  sql: string;
  expectError: boolean;
}

/** Split a SQL test file into cases delimited by `-- @test <name>` markers. */
function parseSqlTests(content: string): SqlTestCase[] {
  const cases: SqlTestCase[] = [];
  let current: SqlTestCase | undefined;
  for (const line of content.split(/\r?\n/)) {
    const testMatch = line.match(/^\s*--\s*@test\s+(.+?)\s*$/);
    if (testMatch) {
      current = { name: testMatch[1], sql: "", expectError: false };
      cases.push(current);
      continue;
    }
    if (!current) continue; // preamble before the first @test marker is ignored
    if (/^\s*--\s*@expect\s+error\s*$/.test(line)) {
      current.expectError = true;
      continue;
    }
    current.sql += `${line}\n`;
  }
  return cases;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface BunFileApi {
  file(path: string): { text(): Promise<string> };
}

function isBunFileApi(value: unknown): value is BunFileApi {
  if (!value || typeof value !== "object") return false;
  const file: unknown = Reflect.get(value, "file");
  return typeof file === "function";
}

/** Default file reader: uses Bun.file without requiring bun types at compile time. */
function defaultReadFile(path: string): Promise<string> {
  const bun: unknown = Reflect.get(globalThis, "Bun");
  if (!isBunFileApi(bun)) {
    throw new Error("runSqlTests: no readFile provided and Bun.file is not available");
  }
  return bun.file(path).text();
}

/**
 * Execute SQL test files in order. Each `-- @test <name>` segment runs inside
 * a transaction (BEGIN; ...; ROLLBACK) for isolation. A segment containing
 * `-- @expect error` passes when the executor throws; otherwise it must
 * succeed. `readFile` defaults to Bun.file(path).text().
 */
export async function runSqlTests(
  executor: SqlExecutor,
  files: string[],
  readFile: (path: string) => Promise<string> = defaultReadFile,
): Promise<SqlTestResult[]> {
  const results: SqlTestResult[] = [];
  for (const file of files) {
    const content = await readFile(file);
    for (const testCase of parseSqlTests(content)) {
      results.push(await runSqlTestCase(executor, file, testCase));
    }
  }
  return results;
}

async function runSqlTestCase(
  executor: SqlExecutor,
  file: string,
  testCase: SqlTestCase,
): Promise<SqlTestResult> {
  const base = { file, name: testCase.name };
  await executor.query("BEGIN");
  try {
    await executor.query(testCase.sql);
    if (testCase.expectError) {
      return { ...base, passed: false, error: "expected an error but the statement succeeded" };
    }
    return { ...base, passed: true };
  } catch (error) {
    if (testCase.expectError) {
      return { ...base, passed: true };
    }
    return { ...base, passed: false, error: errorMessage(error) };
  } finally {
    await executor.query("ROLLBACK");
  }
}

/**
 * Assert that a policy allows the statement: passes when the query does not
 * throw, regardless of the returned rows.
 */
export async function assertPolicyAllows(
  executor: SqlExecutor,
  sql: string,
  opts: { params?: unknown[] } = {},
): Promise<void> {
  try {
    await executor.query(sql, opts.params);
  } catch (error) {
    throw new Error(`assertPolicyAllows: expected the statement to be allowed, but it failed: ${errorMessage(error)}`);
  }
}

/**
 * Assert that a policy denies the statement: passes when the executor throws
 * (insufficient_privilege / RLS violation / permission error) or when the
 * statement returns an empty result set (RLS silently filtered the rows).
 * Fails when rows come back.
 */
export async function assertPolicyDenies(
  executor: SqlExecutor,
  sql: string,
  opts: { params?: unknown[] } = {},
): Promise<void> {
  let rows: unknown[];
  try {
    rows = await executor.query(sql, opts.params);
  } catch {
    return; // permission or RLS error: denied as expected
  }
  if (rows.length === 0) return; // RLS silently filtered all rows
  throw new Error(
    `assertPolicyDenies: expected the statement to be denied, but it returned ${rows.length} row(s)`,
  );
}
