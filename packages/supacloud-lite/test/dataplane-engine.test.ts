import { describe, expect, test } from 'bun:test'
import { createBunSqlEngine, type BunSqlConnection, type BunSqlPool, type BunSqlRows } from '../src/runtime/db/bun-sql-engine.js'
import { createDataPlane, readDataPlaneConfig } from '../src/dataplane.js'

/** Rows array shaped like Bun's `SQL.unsafe` result, including write metadata. */
function rows(command: string, values: unknown[] = [], count?: number): BunSqlRows {
  return Object.assign([...values], count === undefined ? { command } : { command, count })
}

interface Recorded {
  connection: number
  text: string
  params: unknown[]
}

function fakePool(responses: (text: string, params: unknown[]) => BunSqlRows = () => rows('SELECT')) {
  const recorded: Recorded[] = []
  let reserved = 0
  let released = 0
  let closed = 0
  let next = 0
  const pool: BunSqlPool = {
    async reserve(): Promise<BunSqlConnection> {
      const id = next++
      reserved++
      return {
        unsafe(text: string, params: unknown[]): Promise<BunSqlRows> {
          recorded.push({ connection: id, text, params })
          if (text === 'FAIL') return Promise.reject(new Error('statement failed'))
          return Promise.resolve(responses(text, params))
        },
        release(): void {
          released++
        },
      }
    },
    async close(): Promise<void> {
      closed++
    },
  }
  return { pool, recorded, stats: () => ({ reserved, released, closed }) }
}

describe('bun sql engine', () => {
  test('reports affected rows for writes and nothing for reads', async () => {
    const { pool } = fakePool((text) => /^update/i.test(text) ? rows('UPDATE', [], 2) : rows('SELECT', [{ id: 1 }]))
    const engine = createBunSqlEngine({ pool })
    expect(await engine.query('select 1')).toEqual({ rows: [{ id: 1 }] })
    expect(await engine.query('update t set a = 1')).toEqual({ rows: [], affectedRows: 2 })
  })

  test('pins one connection per transaction so request-scoped state cannot leak', async () => {
    const { pool, recorded, stats } = fakePool()
    const engine = createBunSqlEngine({ pool })
    await Promise.all([
      engine.transaction(async (tx) => { await tx.query('select $1', ['a']) }),
      engine.transaction(async (tx) => { await tx.query('select $1', ['b']) }),
    ])
    const first = recorded.filter((entry) => entry.params[0] === 'a').map((entry) => entry.connection)
    const second = recorded.filter((entry) => entry.params[0] === 'b').map((entry) => entry.connection)
    expect(new Set(first).size).toBe(1)
    expect(new Set(second).size).toBe(1)
    expect(first[0]).not.toBe(second[0])
    expect(stats()).toEqual({ reserved: 2, released: 2, closed: 0 })
  })

  test('rolls back and rethrows the original failure', async () => {
    const { pool, recorded } = fakePool()
    const engine = createBunSqlEngine({ pool })
    let caught: unknown
    try {
      await engine.transaction(async (tx) => { await tx.query('FAIL') })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('statement failed')
    expect(recorded.map((entry) => entry.text)).toEqual(['BEGIN', 'FAIL', 'ROLLBACK'])
  })

  test('never silently drops LISTEN', async () => {
    const { pool } = fakePool()
    const engine = createBunSqlEngine({ pool })
    await expect(engine.listen('realtime', () => {})).rejects.toThrow('LISTEN is not supported')
  })

  test('a data plane can leave a shared engine open', async () => {
    const shared = fakePool()
    const engine = createBunSqlEngine({ pool: shared.pool })
    const plane = await createDataPlane({
      engine,
      jwtSecret: 'shared-engine-secret',
      schemaReloadChannels: [],
      closeEngine: false,
    })
    await plane.close()
    expect(shared.stats().closed).toBe(0)
    expect(plane.schemaReload).toBe('disabled')
    await engine.close()
    expect(shared.stats().closed).toBe(1)
  })

  test('closes the pool unless it is shared', async () => {
    const shared = fakePool()
    await createBunSqlEngine({ pool: shared.pool }).close()
    expect(shared.stats().closed).toBe(1)

    const owned = fakePool()
    await createBunSqlEngine({ pool: owned.pool, closePool: false }).close()
    expect(owned.stats().closed).toBe(0)
  })
})

describe('data plane configuration', () => {
  const base = {
    DATA_PLANE_DATABASE_URL: 'postgres://user:pass@localhost:5432/supa_project',
    DATA_PLANE_JWT_SECRET: 'secret',
  }

  test('accepts the PostgREST environment spellings as fallbacks', () => {
    expect(readDataPlaneConfig({
      PGRST_DB_URI: 'postgres://user:pass@localhost:5432/supa_project',
      PGRST_JWT_SECRET: 'secret',
      PGRST_SERVER_PORT: '3101',
      PGRST_DB_SCHEMAS: 'public,storage,graphql_public',
      PGRST_DB_MAX_ROWS: '1000',
    })).toEqual({
      databaseUrl: 'postgres://user:pass@localhost:5432/supa_project',
      jwtSecret: 'secret',
      port: 3101,
      host: '127.0.0.1',
      exposedSchemas: ['public', 'storage', 'graphql_public'],
      maxRows: 1000,
      projectRef: 'unknown',
    })
  })

  test('prefers the data plane names over the PostgREST ones', () => {
    const config = readDataPlaneConfig({
      ...base,
      DATA_PLANE_PORT: '3200',
      PGRST_SERVER_PORT: '3101',
      DATA_PLANE_SCHEMAS: 'public',
      DATA_PLANE_PROJECT_REF: 'abcdefghijkl',
    })
    expect(config.port).toBe(3200)
    expect(config.exposedSchemas).toEqual(['public'])
    expect(config.projectRef).toBe('abcdefghijkl')
    expect(config.maxRows).toBeUndefined()
  })

  test('fails closed on missing or invalid configuration', () => {
    expect(() => readDataPlaneConfig({})).toThrow('DATA_PLANE_DATABASE_URL')
    expect(() => readDataPlaneConfig({ DATA_PLANE_DATABASE_URL: 'postgres://x' })).toThrow('DATA_PLANE_JWT_SECRET')
    expect(() => readDataPlaneConfig({ ...base, DATA_PLANE_PORT: 'not-a-port' })).toThrow('DATA_PLANE_PORT')
    expect(() => readDataPlaneConfig({ ...base, DATA_PLANE_SCHEMAS: ' , ' })).toThrow('DATA_PLANE_SCHEMAS')
    expect(() => readDataPlaneConfig({ ...base, DATA_PLANE_MAX_ROWS: '0' })).toThrow('DATA_PLANE_MAX_ROWS')
  })
})