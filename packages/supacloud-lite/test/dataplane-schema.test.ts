import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from '../src/runtime/db/database.js'
import { createDataPlane, type DataPlane } from '../src/dataplane.js'
import { mintProjectApiKeys } from '../src/runtime/jwt.js'

const jwtSecret = 'data-plane-schema-secret'

let db: Database
let plane: DataPlane
let anonKey: string
let serviceRoleKey: string

function request(
  path: string,
  init: RequestInit & { key?: string } = {},
): Promise<Response> {
  const key = init.key ?? serviceRoleKey
  const headers = new Headers(init.headers)
  headers.set('apikey', key)
  headers.set('authorization', `Bearer ${key}`)
  return plane.fetch(new Request(`http://data-plane.local${path}`, { ...init, headers }))
}

beforeAll(async () => {
  db = await Database.create()
  const keys = await mintProjectApiKeys(jwtSecret)
  anonKey = keys.anonKey
  serviceRoleKey = keys.serviceRoleKey
  await db.exec(`
    create table public.dp_order (
      id bigint generated always as identity primary key,
      label text not null,
      total numeric(10,2),
      tags text[],
      placed_at timestamptz
    );
    create function public.dp_order_total(min_total numeric) returns numeric
      language sql stable as $$ select coalesce(sum(total), 0) from public.dp_order where total >= min_total $$;
    grant select, insert, update, delete on public.dp_order to service_role;
  `)
  plane = await createDataPlane({
    engine: db.engine,
    jwtSecret,
    exposedSchemas: ['public'],
    projectRef: 'dp-schema',
  })
}, 60_000)

afterAll(async () => {
  await plane.close()
})

describe('root OpenAPI document', () => {
  test('describes the negotiated schema, tables, columns and RPC', async () => {
    const response = await request('/rest/v1/')
    expect(response.status).toBe(200)
    const document = await response.json() as Record<string, never>

    expect(document).toMatchObject({
      openapi: '3.0.3',
      info: { title: 'supacloud-dataplane', version: expect.any(String) },
    })

    const paths = document.paths as unknown as Record<string, Record<string, unknown>>
    expect(Object.keys(paths)).toContain('/dp_order')
    expect(Object.keys(paths)).toContain('/rpc/dp_order_total')
    expect(paths['/dp_order']).toMatchObject({
      get: expect.any(Object), post: expect.any(Object), patch: expect.any(Object), delete: expect.any(Object),
    })

    const schemas = (document.components as unknown as { schemas: Record<string, never> }).schemas
    const order = schemas.dp_order as unknown as { type: string; properties: Record<string, Record<string, unknown>> }
    expect(order.type).toBe('object')
    expect(order.properties.id).toMatchObject({ type: 'integer', format: 'int64' })
    expect(order.properties.total).toMatchObject({ type: 'number' })
    expect(order.properties.tags).toMatchObject({ type: 'array' })
    expect(order.properties.placed_at).toMatchObject({ type: 'string', format: 'date-time' })
    expect(order.properties.label).toEqual({ type: 'string' })
  })

  test('is stable across requests so generated clients do not drift', async () => {
    const first = await (await request('/rest/v1/')).text()
    const second = await (await request('/rest/v1/')).text()
    expect(first).toBe(second)
  })

  test('mirrors PostgREST by answering the document on the root path too', async () => {
    const response = await request('/')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ openapi: '3.0.3' })
  })

  test('does not let the root path become a write surface', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await request('/', { method })
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('GET, HEAD')
    }
  })

  test('requires an API key on the root path, like every other data request', async () => {
    const response = await plane.fetch(new Request('http://data-plane.local/'))
    expect(response.status).toBe(401)
  })

  test('advertises only what the caller role can reach', async () => {
    // Bootstrap grants default privileges in `public`, so revoke explicitly:
    // the document follows privileges, not existence.
    await db.exec(`
      revoke all on public.dp_order from anon;
      revoke all on function public.dp_order_total(numeric) from anon;
      -- Functions also carry a default EXECUTE grant to PUBLIC; revoke that too,
      -- otherwise has_function_privilege stays true.
      revoke all on function public.dp_order_total(numeric) from public;
    `)

    const anonResponse = await request('/rest/v1/', { key: anonKey })
    expect(anonResponse.status).toBe(200)
    const anonDocument = await anonResponse.json() as { paths: Record<string, unknown>; info: Record<string, unknown> }
    expect(anonDocument.info['x-role']).toBe('anon')
    expect(Object.keys(anonDocument.paths)).not.toContain('/dp_order')
    expect(Object.keys(anonDocument.paths)).not.toContain('/rpc/dp_order_total')

    const serviceDocument = await (await request('/rest/v1/')).json() as { paths: Record<string, unknown> }
    expect(Object.keys(serviceDocument.paths)).toContain('/dp_order')
  })

  test('keeps every overload out of the document when none is executable', async () => {
    await db.exec(`
      create function public.dp_overload(value integer) returns integer
        language sql stable as $$ select value $$;
      create function public.dp_overload(value text) returns text
        language sql stable as $$ select value $$;
      -- CREATE FUNCTION grants EXECUTE to PUBLIC, so every role starts able to
      -- call both overloads; revoke that before granting a single overload.
      revoke all on function public.dp_overload(integer) from public;
      revoke all on function public.dp_overload(text) from public;
      revoke all on function public.dp_overload(integer) from anon;
      revoke all on function public.dp_overload(text) from anon;
      grant execute on function public.dp_overload(integer) to service_role;
    `)

    const executable = await db.listFunctions('public', { role: 'anon' })
    expect(executable.map((fn) => fn.name)).not.toContain('dp_overload')

    const serviceFunctions = await db.listFunctions('public', { role: 'service_role' })
    expect(serviceFunctions.filter((fn) => fn.name === 'dp_overload')).toHaveLength(1)
  })

  test('fails closed to an empty document for a role that does not exist', async () => {
    expect(await db.listAccessibleRelations('public', 'role_that_does_not_exist')).toEqual(new Set())
    expect(await db.listFunctions('public', { role: 'role_that_does_not_exist' })).toEqual([])
  })

  test('is scoped to the requested profile', async () => {
    const response = await request('/rest/v1/?profile=public', {
      headers: { 'accept-profile': 'public' },
    })
    expect(response.status).toBe(200)
    const document = await response.json() as { info: Record<string, unknown>; paths: Record<string, unknown> }
    expect(document.info['x-exposed-schemas']).toEqual(['public'])
    expect(Object.keys(document.paths)).toContain('/dp_order')
  })
})

describe('schema reload', () => {
  test('health reports the reload capability that is actually wired', async () => {
    const response = await request('/health')
    expect(await response.json()).toMatchObject({ schema_reload: 'active' })
    expect(plane.schemaReload).toBe('active')
  })

  test('NOTIFY invalidates the cached schema of a running plane', async () => {
    // Serve once so the plane caches the pre-DDL schema.
    expect((await request('/rest/v1/dp_order?select=id')).status).toBe(200)

    // A new table is invisible until the cache is invalidated; this is the
    // cross-process case the PostgREST `reload schema` NOTIFY covers.
    await db.exec('create table public.dp_note (id integer primary key, body text)')
    const beforeReload = await request('/rest/v1/dp_note')
    expect(beforeReload.status).toBeGreaterThanOrEqual(400)

    await db.exec("notify supacloud_schema_reload, 'public'")
    await waitFor(async () => (await request('/rest/v1/dp_note')).status === 200)
  }, 20_000)

  test('NOTIFY also drops the cached root document', async () => {
    // Prime the document cache before introducing a new relation.
    expect((await request('/rest/v1/')).status).toBe(200)

    await db.exec('create table public.dp_note_archived (id integer primary key)')
    expect(Object.keys((await (await request('/rest/v1/')).json() as { paths: Record<string, unknown> }).paths))
      .not.toContain('/dp_note_archived')

    await db.exec("notify supacloud_schema_reload, 'public'")
    await waitFor(async () => {
      const body = await (await request('/rest/v1/')).json() as { paths: Record<string, unknown> }
      return Object.keys(body.paths).includes('/dp_note_archived')
    })
  }, 20_000)
})

/** Poll until `predicate` holds, so the test never depends on delivery timing. */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('condition not met before timeout')
}