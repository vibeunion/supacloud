/**
 * `supacloud-lite db diff` core: diff the live project database (which may contain
 * changes made outside migrations) against a fresh "shadow" database that has
 * only the migrations applied. The emitted DDL is the delta you'd save as a
 * new migration.
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { link, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createNativeEngine } from './native/engine.js'
import { createBackend, type SupaCloudLiteBackend } from '../index.js'
import { snapshotSchema, diffSchemas, schemasEqual } from '../db/schema-diff.js'
import { createPgliteEngine } from '../db/pglite-engine.js'
import type { DbEngine, EngineTx } from '../db/engine.js'
import type { MigrationFile } from '../types.js'

/** Inputs for {@link computeDbDiff}: how to reach the live db plus the migrations that define the shadow. */
export interface DbDiffOptions {
  runtimeMode?: import('../functions/profile.js').RuntimeMode
  /** the live project's data dir (wasm) or undefined when a native engine is passed */
  liveDataDir?: string
  /** an already-open live engine; takes precedence over `liveDataDir` when set */
  liveEngine?: import('../db/engine.js').DbEngine
  /** migrations used to construct the migrations-only shadow database */
  migrations: MigrationFile[]
  /** ignored for diffing (seed is data, not schema); accepted so callers can pass one options bag */
  seedSql?: string
  /** schema to diff; defaults to 'public' */
  schema?: string
  /** factory for the shadow engine (native mode); omit for wasm/in-memory shadow */
  makeShadowEngine?: () => Promise<import('../db/engine.js').DbEngine>
}

/** Compute the DDL delta from the migrations-only shadow db to the current live schema. */
export async function computeDbDiff(opts: DbDiffOptions): Promise<string[]> {
  return withDelta(opts, false, async ddl => ddl)
}

async function assertHistory(tx: EngineTx, migrations: MigrationFile[]): Promise<void> {
  const exists = await tx.query<{ ledger: string | null }>("select to_regclass('supabase_migrations.schema_migrations')::text as ledger")
  const rows = exists.rows[0]?.ledger
    ? (await tx.query<{ version: string; statements: string[] | null }>('select version, statements from supabase_migrations.schema_migrations')).rows
    : []
  const expected = new Map<string, string>()
  for (const migration of migrations) {
    const version = migration.name.match(/^(\d+)/)?.[1] ?? migration.name
    if (expected.has(version)) throw new Error(`duplicate migration version: ${version}`)
    expected.set(version, migration.sql)
  }
  if (rows.length !== expected.size || rows.some(row => expected.get(row.version) !== row.statements?.join('\n'))) {
    throw new Error('Schema authoring requires matching applied migration history; resolve pending, missing or changed migrations first')
  }
}

async function withDelta<T>(
  opts: DbDiffOptions, baseline: boolean, action: (ddl: string[], tx: EngineTx) => Promise<T>,
): Promise<T> {
  const schema = opts.schema ?? 'public'
  let shadow: SupaCloudLiteBackend | undefined
  let live: DbEngine | undefined
  let unclaimedLiveEngine = opts.liveEngine
  let operationFailed: boolean = false

  try {
    // shadow = migrations only, fresh
    shadow = await createBackend({
      runtimeMode: opts.runtimeMode,
      engine: opts.makeShadowEngine ? await opts.makeShadowEngine() : undefined,
      migrations: opts.migrations,
      startRuntimeServices: false,
      // no seed: seed is data, not schema
    })
    if (!unclaimedLiveEngine && (!opts.liveDataDir || !existsSync(opts.liveDataDir))) {
      throw new Error('An existing live database is required for schema authoring')
    }
    live = unclaimedLiveEngine ?? await createPgliteEngine(opts.liveDataDir, { inspectOnly: true })
    unclaimedLiveEngine = undefined
    const shadowSnap = await snapshotSchema(shadow.db, schema)
    return await live.transaction(async tx => {
      await tx.exec(`set transaction isolation level repeatable read${baseline ? '' : ' read only'}`)
      await assertHistory(tx, opts.migrations)
      const liveSnap = await snapshotSchema(tx, schema)
      const ddl = diffSchemas(shadowSnap, liveSnap, schema)
      try {
        if (!shadow) throw new Error('Shadow database was closed before schema replay')
        if (ddl.length) await shadow.db.exec(ddl.join('\n'))
        if (!schemasEqual(await snapshotSchema(shadow.db, schema), liveSnap)) {
          throw new Error('Generated DDL does not reproduce the live schema')
        }
      } catch (cause) {
        throw new Error('Lite schema replay validation failed; use the official Supabase pg-delta adapter', { cause })
      }
      return action(ddl, tx)
    })
  } catch (error) {
    operationFailed = true
    throw error
  } finally {
    try {
      await closeResources(unclaimedLiveEngine, live, shadow)
    } catch (error) {
      if (!operationFailed) throw error
    }
  }
}

/** Fresh throwaway data dir for a native-engine shadow database, under the OS temp dir. */
export function shadowNativeDataDir(): string {
  return join(mkdtempSync(join(tmpdir(), 'supacloud-lite-shadow-')), 'pg')
}

export async function createTemporaryNativeEngine(installDir?: string): Promise<import('../db/engine.js').DbEngine> {
  const dataDir = shadowNativeDataDir()
  let engine: import('../db/engine.js').DbEngine
  try {
    engine = await createNativeEngine({ dataDir, installDir })
  } catch (error) {
    try {
      await rm(dirname(dataDir), { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'temporary native database initialization cleanup failed')
    }
    throw error
  }
  return {
    ...engine,
    async close(): Promise<void> {
      try {
        await engine.close()
      } finally {
        await rm(dirname(dataDir), { recursive: true, force: true })
      }
    },
  }
}

/** Inputs for {@link pullSchema}: everything {@link DbDiffOptions} needs plus where/how to write the migration. */
export interface DbPullOptions extends DbDiffOptions {
  /** directory to write the migration into (usually supabase/migrations); omit to skip writing */
  migrationsDir?: string
  /** migration name suffix (default 'remote_schema') */
  name?: string
  /** timestamp version prefix; pass for determinism (default: now as YYYYMMDDHHMMSS) */
  stamp?: string
  /** Explicitly record an already-present schema delta in the live migration ledger. */
  baseline?: boolean
}

/** Outcome of a {@link pullSchema} run. */
export interface DbPullResult {
  /** the diffed DDL statements; empty when live and migrations already match */
  ddl: string[]
  /** timestamp version recorded for the written migration, or null when nothing was written */
  version: string | null
  /** path of the written migration file, or null when `migrationsDir` was omitted or ddl was empty */
  path: string | null
}

/**
 * `supacloud-lite db pull` core: like `db diff`, but writes the delta as a migration
 * without executing its DDL. Baseline explicitly records already-present DDL.
 */
export async function pullSchema(opts: DbPullOptions): Promise<DbPullResult> {
  const stamp = opts.stamp ?? new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const name = opts.name ?? 'remote_schema'
  if (!/^\d{14}$/.test(stamp) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(name)) {
    await opts.liveEngine?.close()
    throw new Error('Invalid migration timestamp or name')
  }
  if (opts.baseline && !opts.migrationsDir) {
    await opts.liveEngine?.close()
    throw new Error('Baseline requires an output directory')
  }
  let stagedPath: string | null = null
  try {
    const result = await withDelta<DbPullResult>(opts, opts.baseline === true, async (ddl, tx) => {
      if (ddl.length === 0) return { ddl, version: null, path: null }
      const body = ddl.join('\n\n') + '\n'
      let path: string | null = null
      if (opts.migrationsDir) {
        await mkdir(opts.migrationsDir, { recursive: true })
        path = join(opts.migrationsDir, `${stamp}_${name}.sql`)
        if (existsSync(path)) throw new Error('Migration file already exists')
        if (opts.baseline) {
          // Publish executable SQL only after the ledger commit is confirmed.
          const pending = `${path}.pending`
          await writeFile(pending, body, { flag: 'wx' })
          stagedPath = pending
          await tx.query(
            'insert into supabase_migrations.schema_migrations(version, name, statements) values ($1, $2, $3)',
            [stamp, `${stamp}_${name}`, [body]],
          )
        } else {
          await writeFile(path, body, { flag: 'wx' })
        }
      }
      return { ddl, version: stamp, path }
    })
    if (stagedPath && result.path) {
      await link(stagedPath, result.path)
      await rm(stagedPath)
    }
    return result
  } catch (error) {
    if (stagedPath) {
      throw new Error(`Baseline outcome requires inspection; staged SQL retained at ${stagedPath}. Verify the ledger before publishing it.`, { cause: error })
    }
    throw error
  }
}

/** Close every initialized backend, surfacing cleanup errors only after both close attempts. */
async function closeResources(
  ...resources: Array<Pick<SupaCloudLiteBackend, 'close'> | import('../db/engine.js').DbEngine | undefined>
): Promise<void> {
  const results = await Promise.allSettled(
    resources.filter((resource) => resource !== undefined).map(async (resource) => await resource.close()),
  )
  const failed = results.find((result) => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
}
