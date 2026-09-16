import { is, type SQL } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import type { DatabaseModule, DatabaseModuleOptions } from "./module.js";
import { defineDatabaseModule } from "./module.js";
import type { CommandDatabase, CommandTransaction } from "./command-adapter";

/** Accept explicit table exports, not arbitrary objects or private type-only metadata. */
export function defineDrizzleDatabaseModule(
  tables: Readonly<Record<string, PgTable>>,
  options: Omit<DatabaseModuleOptions, "tables">,
): DatabaseModule {
  const names = new Set<string>();
  for (const table of Object.values(tables)) {
    if (!is(table, PgTable)) throw new TypeError("Expected a PostgreSQL Drizzle table");
    const config = getTableConfig(table);
    names.add(`${config.schema ?? "public"}.${config.name}`);
  }
  return defineDatabaseModule({ ...options, tables: [...names].sort() });
}

export interface DrizzleCommandTransaction<Database> extends CommandTransaction {
  readonly db: Database;
}

export interface DrizzleCommandDatabaseOptions<Connection, Database> {
  /** Owns BEGIN/COMMIT/ROLLBACK and pins one connection for the callback. */
  transaction<T>(work: (connection: Connection) => Promise<T>): Promise<T>;
  /** Construct Drizzle on this connection, never on the outer connection pool. */
  bind(connection: NoInfer<Connection>): Database;
  /** Execute parameterized protocol SQL on the same connection; return rows only. */
  query(
    connection: NoInfer<Connection>,
    text: string,
    parameters: readonly (string | number | boolean | null)[],
  ): Promise<unknown>;
}

/**
 * One native transaction serves Drizzle business writes and SQL receipts.
 * No SQL placeholder rewriting, hidden second transaction or driver internals.
 */
export function createDrizzleCommandDatabase<Connection, Database>(
  options: DrizzleCommandDatabaseOptions<Connection, Database>,
): CommandDatabase<DrizzleCommandTransaction<Database>> {
  return {
    transaction: (work) => options.transaction(async (connection) => {
      const db = options.bind(connection);
      let active = true;
      try {
        return await work({
          db,
          query: async (text, parameters = []) => {
            if (!active) throw new Error("Command transaction is closed");
            return options.query(connection, text, parameters);
          },
        });
      } finally {
        active = false;
      }
    }),
  };
}

/** Raw SQL results stay unknown until an application-owned decoder validates them. */
export async function executeDecodedSql<Result>(
  executor: { execute(query: SQL): PromiseLike<unknown> },
  query: SQL<unknown>,
  decode: (value: unknown) => Result,
): Promise<Result> {
  return decode(await executor.execute(query));
}
