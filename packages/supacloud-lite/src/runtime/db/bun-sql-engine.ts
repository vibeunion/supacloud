/**
 * `DbEngine` over a pooled PostgreSQL client (Bun's `SQL`) for a database the
 * process does not own: a managed SupaCloud project, an external cluster, or a
 * test database.
 *
 * The embedded engines (PGlite, native) create and bootstrap their own data
 * directory. This adapter attaches to a database that already exists and keeps
 * the same contract, so `Database` introspection and `RestHandler` work
 * unchanged.
 *
 * Transaction-scoped state is the reason every transaction pins one connection:
 * `Database.withContext` issues `set_config('role', ..., true)` and
 * `set_config('request.jwt.claims', ..., true)`, which are transaction-local and
 * must never leak onto a pooled connection borrowed by another request.
 */

import type { DbEngine, EngineResults, EngineTx, EngineUnsubscribe } from './engine.js'

/** Row array as returned by Bun `SQL.unsafe`, carrying write metadata. */
export interface BunSqlRows extends ReadonlyArray<unknown> {
  /** SQL command tag, for example `SELECT`, `INSERT`, `UPDATE`. */
  readonly command?: string
  /** Rows touched by a write command. */
  readonly count?: number
}

/** One reserved connection from the pool. */
export interface BunSqlConnection {
  /** Run one parameterized statement. */
  unsafe(text: string, parameters: unknown[]): PromiseLike<BunSqlRows>
  /** Return the connection to the pool. */
  release(): void
}

/** The narrow pool contract; `Bun.SQL` satisfies it. */
export interface BunSqlPool {
  /** Reserve one connection for the caller's exclusive use. */
  reserve(): Promise<BunSqlConnection>
  /** Close the pool and all of its connections. */
  close(): Promise<void>
}

export interface BunSqlEngineOptions {
  /** Pooled client bound to the database. */
  pool: BunSqlPool
  /** Close the pool when the engine closes. Defaults to `true`. */
  closePool?: boolean
  /**
   * `LISTEN` support. Omit it when the host does not need change events: this
   * adapter cannot hold a channel open on a pooled connection. It never falls
   * back to a silent no-op.
   */
  listen?: (channel: string, onPayload: (payload: string) => void) => Promise<EngineUnsubscribe>
}

const writeCommand = /^(INSERT|UPDATE|DELETE|MERGE)$/

/** Run one statement and normalize the driver result into `EngineResults`. */
async function run(
  connection: BunSqlConnection,
  text: string,
  parameters: unknown[],
): Promise<EngineResults> {
  const result = await connection.unsafe(text, parameters)
  const rows = Array.from(result)
  if (writeCommand.test(result.command ?? '') && result.count !== undefined) {
    return { rows, affectedRows: result.count }
  }
  return { rows }
}

/**
 * Create a `DbEngine` over an existing database.
 *
 * Use `closePool: false` when the same pool is shared with another component
 * (for example a ZenStack adapter) so closing the engine does not disconnect it.
 */
export function createBunSqlEngine(options: BunSqlEngineOptions): DbEngine {
  const { pool, listen } = options
  const closePool = options.closePool !== false

  return {
    async query<T = unknown>(sql: string, params: unknown[] = []): Promise<EngineResults<T>> {
      const connection = await pool.reserve()
      try {
        return await run(connection, sql, params) as EngineResults<T>
      } finally {
        connection.release()
      }
    },

    async exec(sql: string): Promise<void> {
      const connection = await pool.reserve()
      try {
        await run(connection, sql, [])
      } finally {
        connection.release()
      }
    },

    async transaction<T>(fn: (tx: EngineTx) => Promise<T>): Promise<T> {
      const connection = await pool.reserve()
      try {
        await run(connection, 'BEGIN', [])
        const tx: EngineTx = {
          query: async <U = unknown>(sql: string, params: unknown[] = []) =>
            await run(connection, sql, params) as EngineResults<U>,
          exec: async (sql: string) => {
            await run(connection, sql, [])
          },
        }
        const result = await fn(tx)
        await run(connection, 'COMMIT', [])
        return result
      } catch (error) {
        try {
          await run(connection, 'ROLLBACK', [])
        } catch {
          // The connection may already be aborted; the original failure is the
          // one the caller must see.
        }
        throw error
      } finally {
        connection.release()
      }
    },

    async listen(channel: string, onPayload: (payload: string) => void): Promise<EngineUnsubscribe> {
      if (!listen) {
        throw new Error(
          'LISTEN is not supported by this data plane engine; provide the listen option or run change events on their own process'
        )
      }
      return await listen(channel, onPayload)
    },

    async close(): Promise<void> {
      if (closePool) await pool.close()
    },
  }
}