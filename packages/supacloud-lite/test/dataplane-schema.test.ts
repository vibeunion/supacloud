import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from '../src/runtime/db/database.js'
import { createDataPlane, type DataPlane } from '../src/dataplane.js'
import { mintProjectApiKeys } from '../src/runtime/jwt.js'

const jwtSecret = 'data-plane-schema-secret'

let db: Database
let plane: DataPlane
let serviceRoleKey: string

function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('apikey', serviceRoleKey)
  headers.set('authorization', `Bearer ${serviceRoleKey}`)
  return plane.fetch(new Request(`http://data-plane.local${path}`, { ...init, headers }))
}

beforeAll(async () => {
  db = await Database.create()
  serviceRoleKey = (await mintProjectApiKeys(jwtSecret)).serviceRoleKey
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