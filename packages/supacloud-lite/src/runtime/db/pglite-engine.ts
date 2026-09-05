/** PGlite (WASM) engine - imported dynamically so native mode never loads the WASM bundle. */
import type { Extension } from '@electric-sql/pglite'
import type { DbEngine, EngineResults, EngineTx, EngineUnsubscribe } from './engine.js'
import { acquireDataDirLock } from './data-dir-lock.js'
import {
  STANDALONE_PGLITE_ASSETS,
  type StandalonePgliteAssets,
} from '../../standalone-assets-protocol.js'

const INITIALIZE_TIMEZONE_SQL = `
do $$
declare configured_timezone text;
begin
  select split_part(setting, '=', 2) into configured_timezone
  from pg_db_role_setting
  cross join lateral unnest(setconfig) as setting
  where setdatabase = (select oid from pg_database where datname = current_database())
    and setrole = 0
    and lower(split_part(setting, '=', 1)) = 'timezone'
  limit 1;

  if configured_timezone is null then
    configured_timezone := 'UTC';
    execute format('alter database %I set timezone to %L', current_database(), configured_timezone);
  end if;
  perform set_config('TimeZone', configured_timezone, false);
end $$;
`

/**
 * Build a {@link DbEngine} backed by PGlite (WASM Postgres) at `dataDir`, or an
 * in-memory database when `dataDir` is omitted. Loads the bundled contrib
 * extensions Supabase enables by default.
 * @throws if the PGlite WASM bundle isn't available in this build (use the native engine instead).
 */
export async function createPgliteEngine(dataDir?: string): Promise<DbEngine> {
  const releaseLock = await acquireDataDirLock(dataDir, 'PGlite')
  let PGlite, extensions
  const standaloneAssets = getStandaloneAssets()
  let cleanupStandaloneBundles = async () => {}
  try {
    ;({ PGlite } = await import('@electric-sql/pglite'))
    // Supabase enables these by default; load the bundled contrib so migrations
    // that call uuid_generate_v4(), crypt(), citext, etc. work out of the box.
    const [uuid_ossp, pgcrypto, citext, pg_trgm, ltree, hstore, fuzzystrmatch] = await Promise.all([
      import('@electric-sql/pglite/contrib/uuid_ossp').then((m) => m.uuid_ossp),
      import('@electric-sql/pglite/contrib/pgcrypto').then((m) => m.pgcrypto),
      import('@electric-sql/pglite/contrib/citext').then((m) => m.citext),
      import('@electric-sql/pglite/contrib/pg_trgm').then((m) => m.pg_trgm),
      import('@electric-sql/pglite/contrib/ltree').then((m) => m.ltree),
      import('@electric-sql/pglite/contrib/hstore').then((m) => m.hstore),
      import('@electric-sql/pglite/contrib/fuzzystrmatch').then((m) => m.fuzzystrmatch),
    ])
    extensions = { uuid_ossp, pgcrypto, citext, pg_trgm, ltree, hstore, fuzzystrmatch }
  } catch (error) {
    await releaseLock()
    if (error instanceof Error && /wasm/.test(error.message)) throw error
    throw new Error('the PGlite WASM engine is not available in this build')
  }
  if (standaloneAssets) {
    try {
      const standaloneBundles = await standaloneAssets.prepareExtensionBundles()
      cleanupStandaloneBundles = standaloneBundles.cleanup
      extensions = {
        uuid_ossp: withEmbeddedBundle(extensions.uuid_ossp, standaloneBundles.bundles.uuid_ossp),
        pgcrypto: withEmbeddedBundle(extensions.pgcrypto, standaloneBundles.bundles.pgcrypto),
        citext: withEmbeddedBundle(extensions.citext, standaloneBundles.bundles.citext),
        pg_trgm: withEmbeddedBundle(extensions.pg_trgm, standaloneBundles.bundles.pg_trgm),
        ltree: withEmbeddedBundle(extensions.ltree, standaloneBundles.bundles.ltree),
        hstore: withEmbeddedBundle(extensions.hstore, standaloneBundles.bundles.hstore),
        fuzzystrmatch: withEmbeddedBundle(extensions.fuzzystrmatch, standaloneBundles.bundles.fuzzystrmatch),
      }
    } catch (error) {
      await removePreparedBundles(cleanupStandaloneBundles)
      await releaseLock()
      throw error
    }
  }
  let pg: InstanceType<typeof PGlite>
  try {
    pg = new PGlite({
      dataDir,
      extensions,
      ...(standaloneAssets
        ? {
            pgliteWasmModule: standaloneAssets.pgliteWasmModule,
            initdbWasmModule: standaloneAssets.initdbWasmModule,
            fsBundle: standaloneAssets.fsBundle,
          }
        : {}),
    })
    await pg.waitReady
    // PGlite inherits the host timezone at initdb, and its current session does
    // not apply ALTER DATABASE settings.
    try {
      await pg.exec(INITIALIZE_TIMEZONE_SQL)
    } catch (error) {
      const [cleanup] = await Promise.allSettled([pg.close()])
      if (cleanup.status === 'rejected') {
        throw new AggregateError([error, cleanup.reason], 'PGlite timezone initialization and cleanup failed')
      }
      throw error
    }
  } catch (error) {
    await releaseLock()
    throw error
  } finally {
    await removePreparedBundles(cleanupStandaloneBundles)
  }
  let closed: boolean = false

  return {
    async query<T>(sql: string, params?: unknown[]): Promise<EngineResults<T>> {
      const res = await pg.query<T>(sql, params)
      return { rows: res.rows, affectedRows: res.affectedRows }
    },
    async exec(sql: string): Promise<void> {
      await pg.exec(sql)
    },
    transaction<T>(fn: (tx: EngineTx) => Promise<T>): Promise<T> {
      return pg.transaction(async (tx) => {
        return fn({
          async query<R>(sql: string, params?: unknown[]): Promise<EngineResults<R>> {
            const res = await tx.query<R>(sql, params)
            return { rows: res.rows, affectedRows: res.affectedRows }
          },
          async exec(sql: string): Promise<void> {
            await tx.exec(sql)
          },
        })
      }) as Promise<T>
    },
    async listen(channel: string, cb: (payload: string) => void): Promise<EngineUnsubscribe> {
      return pg.listen(channel, cb)
    },
    close: async () => {
      if (closed) return
      closed = true
      try {
        await pg.close()
      } finally {
        await releaseLock()
      }
    },
  }
}

function getStandaloneAssets(): StandalonePgliteAssets | undefined {
  return (globalThis as typeof globalThis & { [key: symbol]: unknown })[STANDALONE_PGLITE_ASSETS] as
    | StandalonePgliteAssets
    | undefined
}

function withEmbeddedBundle<T>(extension: Extension<T>, bundlePath: URL): Extension<T> {
  return {
    ...extension,
    setup: async (pg, emscriptenOpts, clientOnly) => ({
      ...await extension.setup(pg, emscriptenOpts, clientOnly),
      bundlePath,
    }),
  }
}

async function removePreparedBundles(cleanup: () => Promise<void>): Promise<void> {
  try {
    await cleanup()
  } catch (error) {
    // Extensions are already loaded into memory; cleanup failure should not fail an otherwise operational database, but must log diagnostics.
    console.error('Unable to remove temporary PGlite extension bundles:', error)
  }
}
