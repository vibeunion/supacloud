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

/** The driver owns a read-only transaction and enforces its statement timeout. */
export function createBunReadDatabase(pool: SQL, timeoutMs = 5_000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new TypeError("Invalid read statement timeout");
  }
  const admitted = new Map<string, Promise<string>>();
  return Object.freeze({
    async query(text: string, parameters: readonly (string | number | boolean | null)[] = [], signal?: AbortSignal): Promise<unknown> {
      if (signal?.aborted) throw new Error("Read aborted");
      const { assertReadSql } = await import("./sql-analysis");
      let admission = admitted.get(text);
      if (!admission) {
        admission = assertReadSql(text);
        if (admitted.size >= 256) {
          const oldest = admitted.keys().next().value;
          if (oldest !== undefined) admitted.delete(oldest);
        }
        admitted.set(text, admission);
      }
      try { await admission; } catch (error) { admitted.delete(text); throw error; }
      return pool.begin(async (connection) => {
        await connection.unsafe("SET TRANSACTION READ ONLY");
        await connection`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true)`;
        if (signal?.aborted) throw new Error("Read aborted");
        const pending = connection.unsafe<unknown>(text, [...parameters]);
        const abort = () => pending.cancel();
        signal?.addEventListener("abort", abort, { once: true });
        try {
          const rows: unknown = await pending;
          if (signal?.aborted) throw new Error("Read aborted");
          return rows;
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      });
    },
  });
}
