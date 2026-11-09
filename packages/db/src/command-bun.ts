import { SQL, type SQL as SQLType } from "bun";
import type { CommandDatabase } from "./command-adapter";

export interface BunSqlHostOptions {
  /** Environment used to resolve the platform-owned database connection. */
  env?: Record<string, string | undefined>;
  max?: number;
  connectionTimeout?: number;
  closeTimeout?: number;
}

export interface BunSqlHost {
  readonly pool: SQLType;
  close(): Promise<void>;
}

function requiredEnvironment(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required database setting: ${name}`);
  return value;
}

function databaseConnection(env: Record<string, string | undefined>): SQLType.Options {
  const socket = env["DATABASE_SOCKET_PATH"]?.trim();
  const urlValue = env["DATABASE_URL"]?.trim();
  if (socket && urlValue) throw new Error("Conflicting database connection settings");
  if (socket) {
    return {
      adapter: "postgres",
      path: socket,
      database: requiredEnvironment(env, "DATABASE_NAME"),
      username: requiredEnvironment(env, "DATABASE_USER"),
    };
  }
  let url: URL;
  try { url = new URL(requiredEnvironment(env, "DATABASE_URL")); }
  catch { throw new Error("Invalid database URL"); }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("Invalid database URL");
  }
  return {
    adapter: "postgres",
    url: url.href,
    hostname: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port || 5432),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
  };
}

/**
 * Construct the platform-owned Bun SQL pool for an application host.
 * Applications receive the pool through their host composition root and never
 * need to read or parse database credentials themselves.
 */
export function createBunSqlHost(options: BunSqlHostOptions = {}): BunSqlHost {
  const env = options.env ?? (typeof process === "undefined" ? {} : process.env);
  const connection = databaseConnection(env);
  const pool = new SQL({
    ...connection,
    max: options.max ?? 12,
    connectionTimeout: options.connectionTimeout ?? 5,
  });
  let closing: Promise<void> | undefined;
  return {
    pool,
    close: () => closing ??= pool.close({ timeout: options.closeTimeout ?? 5 }),
  };
}

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
