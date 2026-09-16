import type { SQL, TransactionSQL } from "bun";
import { drizzle, type BunSQLDatabase } from "drizzle-orm/bun-sql/postgres";
import type { AnyRelations, EmptyRelations } from "drizzle-orm/relations";
import type { DrizzlePgConfig } from "drizzle-orm/pg-core";
import { createDrizzleCommandDatabase } from "./drizzle";

/** Drizzle is bound to Bun's pinned transaction client, not the application pool. */
export function createBunDrizzleCommandDatabase<Relations extends AnyRelations = EmptyRelations>(
  pool: SQL,
  config: DrizzlePgConfig<Relations> = {},
) {
  return createDrizzleCommandDatabase({
    transaction: async <Result>(work: (connection: TransactionSQL) => Promise<Result>) => {
      const result = await pool.begin(async (connection) => ({ value: await work(connection) }));
      return result.value;
    },
    bind: (connection): BunSQLDatabase<Relations> => drizzle({ ...config, client: connection }),
    query: async (connection, text, parameters) => {
      const rows: unknown = await connection.unsafe<unknown>(text, [...parameters]);
      return rows;
    },
  });
}

/** Explicit read-only unit of work; use a least-privilege pool with the intended RLS identity. */
export function createBunDrizzleReadDatabase<Relations extends AnyRelations = EmptyRelations>(
  pool: SQL,
  config: DrizzlePgConfig<Relations> = {},
  timeoutMs = 5_000,
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new TypeError("Invalid read statement timeout");
  }
  return Object.freeze({
    async read<Result>(work: (db: BunSQLDatabase<Relations>) => Promise<Result>): Promise<Result> {
      const result = await pool.begin(async (connection) => {
        await connection.unsafe("SET TRANSACTION READ ONLY");
        await connection`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true)`;
        return { value: await work(drizzle({ ...config, client: connection })) };
      });
      return result.value;
    },
  });
}
