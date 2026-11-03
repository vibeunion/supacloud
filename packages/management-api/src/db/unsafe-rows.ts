import type { SQL } from "bun";

export interface UnsafeRowsInput<T> {
  sql: SQL;
  /** Stable repository/query name used in diagnostics. */
  source: string;
  sqlText: string;
  values: unknown[];
  decode: (row: unknown) => T;
}

/**
 * The only allowed exit for dynamic parameterized SQL in repositories.
 *
 * Callers must name the query and provide a decoder: raw `sql.unsafe()` rows
 * never become an unchecked domain type. SQL text is never interpolated here;
 * values must be bound through numbered placeholders.
 */
export async function executeUnsafeRows<T>(input: UnsafeRowsInput<T>): Promise<T[]> {
  const sqlText = input.sqlText.trim();
  if (!sqlText) throw new Error(`${input.source}: SQL text is empty`);
  if (!input.sqlText.includes("$1")) throw new Error(`${input.source}: SQL text must use numbered parameters`);
  if (input.values.length === 0) throw new Error(`${input.source}: parameterized SQL requires bound values`);

  const rows: unknown = await input.sql.unsafe(input.sqlText, input.values);
  if (!Array.isArray(rows)) throw new Error(`${input.source}: expected a row array`);
  return rows.map((row, index) => {
    try {
      return input.decode(row);
    } catch (error) {
      throw new Error(`${input.source}: row ${index} failed decoding`, { cause: error });
    }
  });
}
