import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from '../src/runtime/db/database.js'
import { createDataPlane, type DataPlane } from '../src/dataplane.js'
import { mintProjectApiKeys, signJwt } from '../src/runtime/jwt.js'

const jwtSecret = 'data-plane-test-secret'

let db: Database
let plane: DataPlane
let anonKey: string
let serviceRoleKey: string
let authenticatedKey: string

function request(path: string, init: RequestInit & { key?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (init.key) {
    headers.set('apikey', init.key)
    headers.set('authorization', `Bearer ${init.key}`)
  }
  return plane.fetch(new Request(`http://data-plane.local${path}`, { ...init, headers }))
}

beforeAll(async () => {
  db = await Database.create()
  const keys = await mintProjectApiKeys(jwtSecret)
  anonKey = keys.anonKey
  serviceRoleKey = keys.serviceRoleKey
  authenticatedKey = await signJwt({ role: 'authenticated', sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 600 }, jwtSecret)

  // The data plane attaches to a database it does not bootstrap: everything
  // below stands in for project-owned schema, grants and RLS.
  await db.exec(`
    create table public.dp_item (
      id bigint generated always as identity primary key,
      name text not null,
      secret text
    );
    alter table public.dp_item enable row level security;
    create policy dp_item_member_read on public.dp_item
      for select to authenticated using (true);
    create policy dp_item_member_write on public.dp_item
      for all to authenticated using (true) with check (true);
    create policy dp_item_anon_read on public.dp_item
      for select to anon using (false);
    grant select on public.dp_item to anon;
    grant select, insert, update, delete on public.dp_item to authenticated;
    grant select, insert, update, delete on public.dp_item to service_role;
    insert into public.dp_item (name, secret) values ('first', 'a'), ('second', 'b'), ('third', 'c');
  `)

  plane = await createDataPlane({
    engine: db.engine,
    jwtSecret,
    exposedSchemas: ['public'],
    projectRef: 'dp-test',
  })
}, 60_000)

afterAll(async () => {
  await plane.close()
})

describe('data plane identity', () => {
  test('rejects a request without an API key', async () => {
    const response = await request('/rest/v1/dp_item')
    expect(response.status).toBe(401)
  })

  test('rejects a forged API key', async () => {
    const response = await request('/rest/v1/dp_item', { key: 'not-a-jwt' })
    expect(response.status).toBe(401)
  })

  test('rejects a role outside anon/authenticated/service_role', async () => {
    const key = await signJwt({ role: 'postgres', exp: Math.floor(Date.now() / 1000) + 600 }, jwtSecret)
    const response = await request('/rest/v1/dp_item', { key })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ message: 'Invalid role: postgres' })
  })
})

describe('data plane keeps PostgreSQL RLS in the path', () => {
  test('anon sees no rows because the RLS policy denies it', async () => {
    const response = await request('/rest/v1/dp_item', { key: anonKey })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
  })

  test('authenticated sees the rows its policy allows', async () => {
    const response = await request('/rest/v1/dp_item?select=name&order=id.asc', { key: authenticatedKey })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([{ name: 'first' }, { name: 'second' }, { name: 'third' }])
  })
})

describe('data plane speaks the PostgREST read contract', () => {
  test('honours Range and reports Content-Range', async () => {
    const response = await request('/rest/v1/dp_item?select=id&order=id.asc', {
      key: serviceRoleKey,
      headers: { range: '0-1', 'range-unit': 'items' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-range')).toBe('0-1/*')
    expect(await response.json()).toEqual([{ id: (await firstId()) }, { id: (await firstId()) + 1 }])
  })

  test('honours Prefer: count=exact', async () => {
    const response = await request('/rest/v1/dp_item?select=id', {
      key: serviceRoleKey,
      headers: { prefer: 'count=exact' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-range')).toBe('0-2/3')
  })

  test('rejects an unexposed profile schema with PGRST106', async () => {
    const response = await request('/rest/v1/dp_item', {
      key: anonKey,
      headers: { 'accept-profile': 'storage', prefer: 'count=none' },
    })
    expect(response.status).toBe(406)
    expect(await response.json()).toMatchObject({ code: 'PGRST106' })
  })
})

describe('data plane speaks the PostgREST write contract', () => {
  test('returns the mutated row for Prefer: return=representation', async () => {
    const response = await request('/rest/v1/dp_item?name=eq.first', {
      key: serviceRoleKey,
      method: 'PATCH',
      headers: { prefer: 'return=representation', 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'rotated' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject([{ name: 'first', secret: 'rotated' }])
  })

  test('enforces RLS on writes instead of trusting the request', async () => {
    const response = await request('/rest/v1/dp_item', {
      key: anonKey,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'anon-write' }),
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
    const names = await request('/rest/v1/dp_item?select=name', { key: serviceRoleKey })
    expect(await names.json()).not.toContainEqual({ name: 'anon-write' })
  })
})

describe('data plane process surface', () => {
  test('health reports the project and engine', async () => {
    const response = await request('/health')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      name: 'supacloud-dataplane',
      project_ref: 'dp-test',
      status: 'healthy',
      engine: 'postgres',
    })
  })

  test('refuses to serve another service surface', async () => {
    const response = await request('/auth/v1/token', { key: anonKey })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ message: expect.stringContaining('/rest/v1') })
  })
})

/** Read the lowest id once so Range assertions do not hard-code identity values. */
async function firstId(): Promise<number> {
  const response = await request('/rest/v1/dp_item?select=id&order=id.asc', { key: serviceRoleKey })
  const rows = await response.json() as Array<{ id: number }>
  return rows[0]!.id
}