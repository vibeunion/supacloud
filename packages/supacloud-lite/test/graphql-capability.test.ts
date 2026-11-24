import { expect, test } from 'bun:test'
import { mkdtemp, rm, readdir, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackend } from '../src/runtime/index.js'
import { GraphqlHandler, LITE_GRAPHQL_CONTRACT, inspectGraphql } from '../src/runtime/graphql.js'
import { readJson, record } from './support/contracts.js'

test('Lite GraphQL uses the hosted Hasura read contract and records the gaps', () => {
  expect(LITE_GRAPHQL_CONTRACT).toEqual({
    path: '/graphql/v1',
    dialect: 'postrust-hasura',
    hostedDialect: 'postrust-hasura',
    interchangeableWithHosted: true,
    limits: [
      'mutations-not-implemented',
      'aggregates-not-implemented',
      'subscriptions-not-implemented',
      'relationship-filters-not-implemented',
      'db-pre-request-not-applied',
      'relay-documents-rejected',
    ],
  })
  expect(LITE_GRAPHQL_CONTRACT.dialect).toBe(LITE_GRAPHQL_CONTRACT.hostedDialect)
})

test('PGlite serves Hasura reads under GRANT and RLS without pg_graphql', async () => {
  const backend = await createBackend({ startRuntimeServices: false, graphql: { enabled: true } })
  try {
    expect(backend.graphql).toEqual({ status: 'supported', extension: 'postrust-hasura', dialect: 'postrust-hasura' })
    expect(await inspectGraphql()).toEqual(backend.graphql)
    await backend.db.exec(`
      create table public.authors (id int primary key, name text not null);
      create table public.notes (
        id int primary key,
        author_id int references public.authors(id),
        owner text not null
      );
      alter table public.notes enable row level security;
      create policy notes_read on public.notes for select to authenticated
        using (owner = coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub');
      grant select on public.authors, public.notes to anon, authenticated;
      insert into public.authors values (1, 'Alice'), (2, 'Bob');
      insert into public.notes values (1, 1, 'alice'), (2, 2, 'bob');
    `)
    const handler = new GraphqlHandler(backend.db, backend.graphql)
    const send = (query: string, role: string, sub?: string) => handler.handle(new Request('http://local/graphql/v1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    }), { role, claims: { role, ...(sub ? { sub } : {}) } })
    const alice = record(await readJson(await send(
      '{ notes(where: { owner: { _eq: "alice" } }, order_by: [{ id: asc }], limit: 10) { id owner author { name } } }',
      'authenticated',
      'alice',
    )))
    expect(alice['errors']).toBeUndefined()
    expect(alice['data']).toEqual({ notes: [{ id: 1, owner: 'alice', author: { name: 'Alice' } }] })
    const anon = record(await readJson(await send('{ notes { id } }', 'anon')))
    expect(anon['data']).toEqual({ notes: [] })
    const relay = record(await readJson(await send('{ notesCollection(first: 1) { edges { node { id } } } }', 'authenticated', 'alice')))
    expect(relay['data']).toBeNull()
    expect(JSON.stringify(relay['errors'])).toContain('notesCollection')
    const mutation = record(await readJson(await send('mutation { insert_notes(objects: [{ id: 9 }]) { affected_rows } }', 'authenticated', 'alice')))
    expect(JSON.stringify(mutation['errors'])).toContain('not implemented')
    expect(mutation['data']).toBeUndefined()
  } finally { await backend.close() }
})

test('GraphQL adapter rejects malformed and oversized requests before database execution', async () => {
  const backend = await createBackend({ startRuntimeServices: false })
  try {
    // Transport-only tests; this does not claim a fake extension is compatible.
    const handler = new GraphqlHandler(backend.db, { status: 'supported', extension: 'postrust-hasura', dialect: 'postrust-hasura' }, { maxRequestBodyBytes: 80 })
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

test('GraphQL adapter emits sanitized duration metrics for slow requests', async () => {
  const backend = await createBackend({ startRuntimeServices: false })
  const metrics: Array<Record<string, unknown>> = []
  try {
    const handler = new GraphqlHandler(
      backend.db,
      { status: 'supported', extension: 'postrust-hasura', dialect: 'postrust-hasura' },
      { slowQueryThresholdMs: 1, onRequest: (metric) => metrics.push({ ...metric }) },
    )
    const response = await handler.handle(new Request('http://local/graphql/v1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }', operationName: 'Health' }),
    }), { role: 'anon', claims: null })
    expect(response.status).toBe(200)
    expect(metrics).toHaveLength(1)
    expect(metrics[0]).toMatchObject({ operationName: 'Health', status: 200 })
    expect(typeof metrics[0]?.['slow']).toBe('boolean')
    expect(metrics[0]).not.toHaveProperty('query')
    expect(metrics[0]).not.toHaveProperty('variables')
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

test('GraphQL support does not depend on a pg_graphql catalog row', async () => {
  expect(await inspectGraphql()).toEqual({ status: 'supported', extension: 'postrust-hasura', dialect: 'postrust-hasura' })
})
