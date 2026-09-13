import type { SQL } from "bun";
import type { CommandDatabase } from "./command-adapter";

/** The SQL pool owns one connection from BEGIN through COMMIT/ROLLBACK. */
export function createBunCommandDatabase(sql: SQL): CommandDatabase {
  return {
    async transaction(run) {
      const result = await sql.begin(async (connection) => ({
        value: await run({
          query: async (text, parameters = []) => {
            const rows: unknown = await connection.unsafe<unknown>(text, [...parameters]);
            return rows;
          },
        }),
      }));
      return result.value;
    },
  };
}
