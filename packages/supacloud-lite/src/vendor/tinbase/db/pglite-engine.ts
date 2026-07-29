/** PGlite (WASM) engine - imported dynamically so native mode never loads the WASM bundle. */
import { mkdir, open, readFile, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { DbEngine, EngineResults, EngineTx } from './engine.js'

/**
 * Build a {@link DbEngine} backed by PGlite (WASM Postgres) at `dataDir`, or an
 * in-memory database when `dataDir` is omitted. Loads the bundled contrib
 * extensions Supabase enables by default.
 * @throws if the PGlite WASM bundle isn't available in this build (use the native engine instead).
 */
export async function createPgliteEngine(dataDir?: string): Promise<DbEngine> {
  const releaseLock = await acquireDataDirLock(dataDir)
  let PGlite, extensions
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
  } catch (e) {
    await releaseLock()
    if (e instanceof Error && /wasm/.test(e.message)) throw e
    throw new Error('the PGlite WASM engine is not available in this build')
  }
  let pg: InstanceType<typeof PGlite>
  try {
    pg = new PGlite({ dataDir, extensions })
    await pg.waitReady
  } catch (error) {
    await releaseLock()
    throw error
  }
  let closed = false

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
    async listen(channel: string, cb: (payload: string) => void): Promise<() => void> {
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

async function acquireDataDirLock(dataDir?: string): Promise<() => Promise<void>> {
  if (!dataDir || dataDir.includes('://')) return async () => {}
  const absoluteDataDir = resolve(dataDir)
  const lockPath = `${absoluteDataDir}.supacloud-lite.lock`
  await mkdir(dirname(absoluteDataDir), { recursive: true, mode: 0o700 })
  const nonce = crypto.randomUUID()
  const handle = await createDataDirLock(absoluteDataDir, lockPath, nonce)
  let released = false
  return async () => {
    if (released) return
    released = true
    await handle?.close()
    const owner = await readLockOwner(lockPath)
    if (owner?.nonce !== nonce) return
    await unlink(lockPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
}

async function createDataDirLock(absoluteDataDir: string, lockPath: string, nonce: string): Promise<FileHandle> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await writeDataDirLock(lockPath, nonce)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const owner = await readLockOwner(lockPath)
      if (owner && isProcessAlive(owner.pid)) throw lockInUseError(absoluteDataDir, owner.pid)
      if (!owner || attempt > 0) throw unreadableLockError(lockPath)
      await unlink(lockPath).catch((unlinkError) => {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError
      })
    }
  }
  throw unreadableLockError(lockPath)
}

async function writeDataDirLock(lockPath: string, nonce: string): Promise<FileHandle> {
  const handle = await open(lockPath, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, nonce, createdAt: new Date().toISOString() })}\n`)
    return handle
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(lockPath).catch(() => {})
    throw error
  }
}

function lockInUseError(dataDir: string, pid: number): Error {
  return new Error(`PGlite data directory is already in use: ${dataDir} (pid ${pid})`)
}

function unreadableLockError(lockPath: string): Error {
  return new Error(
    `PGlite data directory has an unreadable lock: ${lockPath}. ` +
      'Confirm no SupaCloud Lite process is using it, then remove the lock manually.'
  )
}

async function readLockOwner(lockPath: string): Promise<{ pid: number; nonce: string } | null> {
  try {
    const value = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: unknown; nonce?: unknown }
    return typeof value.pid === 'number' && Number.isInteger(value.pid) && value.pid > 0 && typeof value.nonce === 'string'
      ? { pid: value.pid, nonce: value.nonce }
      : null
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
