import { expect, test } from 'bun:test'
import { createBackend } from '../src/runtime/index.js'
import { signJwt } from '../src/runtime/jwt.js'
import { buildWireEngine } from '../src/runtime/node/native/wire-engine.js'
import { PgWireClient } from '../src/runtime/node/native/wire.js'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { callExport, callMethod, orderNodes, readJson, record } from './support/contracts.js'
import { compileProject, pullGraphqlSchema } from '@supacloud/compiler'

const nativeGraphql = process.env.SUPACLOUD_LITE_TEST_GRAPHQL === '1' ? test : test.skip

nativeGraphql('real pg_graphql: role-scoped schema, nested RLS, mutation denial and request isolation', async () => {
  const name = `supacloud-lite-graphql-${crypto.randomUUID()}`
  const password = crypto.randomUUID()
  const work = await mkdtemp(join(tmpdir(), 'lite-graphql-generated-'))
  let created = false
  let backend: Awaited<ReturnType<typeof createBackend>> | undefined
  let engine: Awaited<ReturnType<typeof buildWireEngine>> | undefined
  const current = () => {
    if (!backend) throw new Error('GraphQL fixture backend is not running')
    return backend
  }
  const command = async (args: string[]) => {
    const proc = Bun.spawn(args, { env: { ...process.env, POSTGRES_PASSWORD: password }, stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => proc.kill(), 60_000)
    try {
      const [code, output, error] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      if (code !== 0) throw new Error(`GraphQL fixture command failed: ${error.replaceAll(password, '[redacted]')}`)
      return output.trim()
    } finally {
      clearTimeout(timer)
      if (proc.exitCode === null) { proc.kill(); await proc.exited }
    }
  }
  try {
    await command(['docker', 'run', '-d', '--name', name, '--label', 'supacloud.lite-test=graphql',
      '--tmpfs', '/var/lib/postgresql:rw,size=512m', '-p', '127.0.0.1::5432',
      '-e', 'POSTGRES_PASSWORD', 'supacloud-graphql-test:pg18'])
    created = true
    const port = Number((await command(['docker', 'port', name, '5432/tcp'])).split(':').at(-1))
    const connect = () => PgWireClient.connect({ host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres' })
    const deadline = Date.now() + 30_000
    while (true) {
      try { const ready = await connect(); await ready.close(); break } catch (error) {
        if (Date.now() >= deadline) throw error
        await Bun.sleep(150)
      }
    }
    engine = await buildWireEngine({ connect })
    backend = await createBackend({
      engine, startRuntimeServices: false, log: () => {},
    })
    expect(backend.graphql.reason).toBe('PG_GRAPHQL_NOT_INSTALLED')
    await backend.migrate([{ name: '100_graphql', sql: `
        create extension pg_graphql;
        grant usage on schema graphql to anon, authenticated, service_role;
        grant execute on all functions in schema graphql to anon, authenticated, service_role;
        comment on schema public is '@graphql({"inflect_names": true, "introspection": true})';
        create table public.customers(id int primary key, tenant text not null, name text not null);
        create table public.orders(id int primary key, tenant text not null, customer_id int references public.customers(id));
        revoke all on public.customers, public.orders from public, anon, authenticated;
        alter table public.customers enable row level security;
        alter table public.orders enable row level security;
        create policy customers_read on public.customers for select to authenticated using (tenant = auth.jwt()->>'tenant_id');
        create policy orders_read on public.orders for select to authenticated using (tenant = auth.jwt()->>'tenant_id');
        grant select on public.customers, public.orders to authenticated;
        insert into public.customers values (1, 'a', 'Alice'), (2, 'b', 'Bob');
        insert into public.orders values (1, 'a', 1), (2, 'b', 2), (3, 'a', 2);
      ` }])
    expect(backend.graphql.status).toBe('supported')
    expect(backend.graphql.reason).toBeUndefined()
    expect(backend.graphql.version).toBeTruthy()
    const credential = (tenant: string) => signJwt({ role: 'authenticated', tenant_id: tenant,
      sub: '00000000-0000-0000-0000-000000000001', exp: Math.floor(Date.now() / 1000) + 60 }, current().jwtSecret)
    const tokens = { a: await credential('a'), b: await credential('b') }
    const graphql = async (query: string, token = current().anonKey) => {
      const response = await current().fetch('http://local/graphql/v1', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ query }),
      })
      return { status: response.status, body: record(await readJson(response)) }
    }
    const query = '{ ordersCollection(orderBy: [{id: AscNullsLast}]) { edges { node { id customer { name } } } } }'
    const a = await graphql(query, tokens.a)
    expect(a.status).toBe(200)
    expect(a.body['errors']).toBeUndefined()
    expect(orderNodes(a.body['data'])).toEqual([
      { id: 1, customer: { name: 'Alice' } }, { id: 3, customer: null },
    ])
    const b = await graphql(query, tokens.b)
    expect(orderNodes(b.body['data'])).toEqual([{ id: 2, customer: { name: 'Bob' } }])
    expect((await graphql(query)).body['errors']).toBeTruthy()
    expect((await graphql(query, tokens.a + 'x')).status).toBe(401)
    const schema = join(work, 'schema.graphql')
    await pullGraphqlSchema({ url: 'http://127.0.0.1', output: schema, accessToken: tokens.a, fetch: backend.fetch })
    await mkdir(join(work, 'src'))
    await writeFile(join(work, 'src/orders.graphql'), 'query OrderList($id: Int!) { ordersCollection(filter: {id: {eq: $id}}) { edges { node { id customer { name } } } } }')
    const compilation = await compileProject({ rootDir: join(work, 'src'), outDir: join(work, 'generated'), graphql: { schema } })
    expect(compilation.diagnostics).toEqual([])
    const client = record(await callExport(pathToFileURL(join(work, 'generated/graphql.ts')).href, 'createGraphqlClient',
      { url: 'http://127.0.0.1', getAccessToken: () => tokens.a, fetch: backend.fetch }))
    expect(orderNodes(await callMethod(client, 'OrderList', { id: 1 }))).toEqual([{ id: 1, customer: { name: 'Alice' } }])
    expect(orderNodes(await callMethod(client, 'OrderList', { id: 2 }))).toEqual([])
    const introspection = '{ __schema { queryType { fields { name } } mutationType { fields { name } } } }'
    expect((await graphql(introspection, tokens.a)).body['errors']).toBeUndefined()
    expect(JSON.stringify((await graphql(introspection)).body)).not.toContain('ordersCollection')
    expect(JSON.stringify((await graphql(introspection, tokens.a)).body)).not.toContain('updateOrdersCollection')
    expect((await graphql('mutation { deleteFromOrdersCollection(filter: {id: {eq: 1}}) { affectedCount } }', tokens.a)).body['errors']).toBeTruthy()
    expect((await backend.db.query<unknown>('select count(*)::int as count from public.orders')).rows).toEqual([{ count: 3 }])
    for (const result of await Promise.all(Array.from({ length: 6 }, (_, index) => graphql(query, index % 2 ? tokens.a : tokens.b)))) {
      expect(result.body['errors']).toBeUndefined()
      const nodes = orderNodes(result.body['data']).map((node) => node.id)
      expect(nodes === undefined).toBe(false)
      expect(nodes.join(',') === '1,3' || nodes.join(',') === '2').toBe(true)
    }
    const secret = backend.jwtSecret
    await backend.close()
    backend = undefined
    engine = await buildWireEngine({ connect })
    backend = await createBackend({ engine, jwtSecret: secret, graphql: { enabled: true }, startRuntimeServices: false, log: () => {} })
    expect((await graphql(query)).body['errors']).toBeTruthy()
    expect(JSON.stringify((await graphql(introspection, tokens.a)).body)).not.toContain('updateOrdersCollection')
    expect(orderNodes((await graphql(query, tokens.b)).body['data'])).toHaveLength(1)
    console.log(`Verified real pg_graphql ${backend.graphql.version} on PostgreSQL 18`)
    await backend.migrate([{ name: '101_remove_graphql', sql: 'drop extension pg_graphql cascade' }])
    expect(backend.graphql.status).toBe('unsupported')
    expect(backend.graphql.version).toBeUndefined()
    expect((await graphql(query, tokens.a)).status).toBe(501)
  } finally {
    try {
      if (backend) await backend.close()
      else await engine?.close()
    } finally {
      try { if (created) await command(['docker', 'rm', '-f', name]) }
      finally { await rm(work, { recursive: true, force: true }) }
    }
  }
}, 120_000)
