import { expect, test } from 'bun:test'
import { mkdtemp, rm, readdir, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackend } from '../src/runtime/index.js'
import { GraphqlHandler, inspectGraphql } from '../src/runtime/graphql.js'

test('PGlite truthfully reports missing pg_graphql and rejects required startup', async () => {
  const backend = await createBackend({ startRuntimeServices: false })
  try {
    expect(backend.graphql).toEqual({ status: 'unsupported', extension: 'pg_graphql', reason: 'PG_GRAPHQL_NOT_INSTALLED' })
    const response = await backend.fetch('http://local/graphql/v1', {
      method: 'POST', headers: { apikey: backend.anonKey }, body: '{}',
    })
    expect(response.status).toBe(501)
    expect((await response.json()).errors[0].extensions.code).toBe('PG_GRAPHQL_NOT_INSTALLED')
    await backend.db.exec('create schema graphql; create function graphql.resolve(text, jsonb, text, jsonb) returns jsonb language sql as $$ select \'{}\'::jsonb $$')
    expect((await inspectGraphql(backend.db.engine)).status).toBe('unsupported')
  } finally { await backend.close() }
  await expect(createBackend({ graphql: { enabled: true }, startRuntimeServices: false })).rejects.toThrow('PG_GRAPHQL_NOT_INSTALLED')
})

test('GraphQL adapter rejects malformed and oversized requests before database execution', async () => {
  const backend = await createBackend({ startRuntimeServices: false })
  try {
    // Transport-only tests; this does not claim a fake extension is compatible.
    const handler = new GraphqlHandler(backend.db, { status: 'supported', extension: 'pg_graphql' }, { maxRequestBodyBytes: 80 })
    const request = (body: string, type = 'application/json') => new Request('http://local/graphql/v1', {
      method: 'POST', headers: { 'content-type': type }, body,
    })
    const ctx = { role: 'anon', claims: null }
    expect((await handler.handle(new Request('http://local/graphql/v1'), ctx)).status).toBe(405)
    expect((await handler.handle(request('{}', 'text/plain'), ctx)).status).toBe(415)
    for (const body of ['[{}]', '{', '{"query":1}', '{"query":"q","variables":[]}']) {
      expect((await handler.handle(request(body), ctx)).status).toBe(400)
    }
    expect((await handler.handle(request(JSON.stringify({ query: 'x'.repeat(100) })), ctx)).status).toBe(413)
  } finally { await backend.close() }
})

test('doctor reports unverified capability without initializing state and fails required capability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lite-doctor-capability-'))
  try {
    const run = async () => {
      const proc = Bun.spawn([process.execPath, 'src/cli.ts', 'doctor', '--json', '--project-dir', root], {
        cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe',
      })
      const [code, text, error] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      expect(error).toBe('')
      return { code, report: JSON.parse(text) }
    }
    const initial = await run()
    expect(initial.code).toBe(0)
    expect(initial.report.graphql.status).toBe('unverified')
    expect(await readdir(root)).toEqual([])
    await mkdir(join(root, 'supabase'))
    await writeFile(join(root, 'supabase/config.toml'),
      '[lite.graphql]\nenabled = true\n[lite.identity]\nmodule = "missing-identity.ts"\n')
    const required = await run()
    expect(required.code).toBe(1)
    expect(required.report.graphql.status).toBe('unverified')
    expect(await readdir(root)).toEqual(['supabase'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('catalog membership alone does not advertise a missing extension library', async () => {
  const backend = await createBackend({ startRuntimeServices: false })
  try {
    const engine = {
      ...backend.db.engine,
      query: async <T>(sql: string) => {
        if (sql.includes('pg_extension e')) return { rows: [{ extversion: 'test', resolver: true }] as T[] }
        throw new Error('private dynamic library path')
      },
    }
    expect(await inspectGraphql(engine)).toEqual({
      status: 'unsupported', extension: 'pg_graphql', version: 'test', reason: 'PG_GRAPHQL_RESOLVER_FAILED',
    })
  } finally { await backend.close() }
})
