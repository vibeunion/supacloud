import { expect, test } from 'bun:test'
import { mkdtemp, rm, readdir, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackend } from '../src/runtime/index.js'
import { GraphqlHandler, inspectGraphql } from '../src/runtime/graphql.js'
import { readJson, record } from './support/contracts.js'

test('PGlite truthfully reports missing pg_graphql and rejects required startup', async () => {
  const backend = await createBackend({ startRuntimeServices: false })
  try {
    expect(backend.graphql).toEqual({ status: 'unsupported', extension: 'pg_graphql', reason: 'PG_GRAPHQL_NOT_INSTALLED' })
    const response = await backend.fetch('http://local/graphql/v1', {
      method: 'POST', headers: { apikey: backend.anonKey }, body: '{}',
    })
    expect(response.status).toBe(501)
    expect(await readJson(response)).toMatchObject({
      errors: [{ extensions: { code: 'PG_GRAPHQL_NOT_INSTALLED' } }],
    })
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
    // Validate a malformed resolver payload without advertising it as a real extension.
    await backend.db.exec(`
      create schema graphql;
      create function graphql.resolve(text,jsonb,text,jsonb) returns jsonb
        language sql as $$ select '42'::jsonb $$;
      grant usage on schema graphql to anon;
      grant execute on all functions in schema graphql to anon;
    `)
    for (const payload of ['42', '{"data":42}', '{"errors":[{}]}', '{"data":null,"extensions":[]}']) {
      await backend.db.exec(`
        create or replace function graphql.resolve(text,jsonb,text,jsonb) returns jsonb
          language sql as $$ select '${payload}'::jsonb $$;
      `)
      const malformed = await handler.handle(request('{"query":"{ __typename }"}'), ctx)
      expect(malformed.status).toBe(500)
      expect(await readJson(malformed)).toMatchObject({
        errors: [{ extensions: { code: 'GRAPHQL_EXECUTION_FAILED' } }],
      })
    }
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
      const report: unknown = JSON.parse(text)
      return { code, report: record(report) }
    }
    const initial = await run()
    expect(initial.code).toBe(0)
    expect(record(initial.report['graphql'])['status']).toBe('unverified')
    expect(await readdir(root)).toEqual([])
    await mkdir(join(root, 'supabase'))
    await writeFile(join(root, 'supabase/config.toml'),
      '[lite.graphql]\nenabled = true\n[lite.identity]\nmodule = "missing-identity.ts"\n')
    const required = await run()
    expect(required.code).toBe(1)
    expect(record(required.report['graphql'])['status']).toBe('unverified')
    expect(await readdir(root)).toEqual(['supabase'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('catalog membership alone does not advertise a missing extension library', async () => {
    const engine = {
      query: async (sql: string) => {
        if (sql.includes('pg_extension e')) return { rows: [{ extversion: 'test', resolver: true }] }
        throw new Error('private dynamic library path')
      },
    }
    expect(await inspectGraphql(engine)).toEqual({
      status: 'unsupported', extension: 'pg_graphql', version: 'test', reason: 'PG_GRAPHQL_RESOLVER_FAILED',
    })
})

test('invalid catalog records cannot advertise GraphQL support', async () => {
  for (const row of [null, [], { extversion: '1.6.1', resolver: 'true' }, { extversion: 1, resolver: true }]) {
    expect((await inspectGraphql({ query: async () => ({ rows: [row] }) })).reason).toBe('PG_GRAPHQL_INVALID_CATALOG')
  }
})
