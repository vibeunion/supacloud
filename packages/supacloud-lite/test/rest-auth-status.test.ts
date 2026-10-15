import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from '../src/runtime/db/database.js'
import { errorToResponse } from '../src/runtime/rest/errors.js'
import { RestHandler } from '../src/runtime/rest/handler.js'
import { ApiError } from '../src/runtime/types.js'

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('REST insufficient privilege HTTP status', () => {
  let db: Database | undefined
  let rest: RestHandler

  beforeAll(async () => {
    db = await Database.create()
    await db.exec(`
      create table public.restricted_items (id integer primary key);
      insert into public.restricted_items values (1);
      revoke all on public.restricted_items from public, anon, authenticated, service_role;
      create function public.restricted_rpc() returns boolean language sql stable as $$ select true $$;
      revoke all on function public.restricted_rpc() from public, anon, authenticated, service_role;

      create table public.owner_items (id integer primary key, owner_id uuid not null);
      insert into public.owner_items values (1, '${userId}');
      alter table public.owner_items enable row level security;
      create policy owner_select on public.owner_items for select to authenticated using (owner_id = auth.uid());
      create policy owner_insert on public.owner_items for insert to authenticated with check (owner_id = auth.uid());
    `)
    rest = new RestHandler(db)
  }, 60_000)

  beforeEach(async () => {
    await db!.query('delete from public.owner_items where id <> 1')
  })

  afterAll(async () => {
    await db?.close()
  })

  function request(path: string, role: 'anon' | 'authenticated' | 'service_role', body?: Record<string, unknown>) {
    const url = new URL(`http://lite.local/rest/v1/${path}`)
    return rest.handle(new Request(url, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', prefer: 'return=representation' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), { role, claims: { role, ...(role === 'authenticated' ? { sub: userId } : {}) } }, url)
  }

  for (const role of ['anon', 'authenticated', 'service_role'] as const) {
    for (const path of ['restricted_items', 'rpc/restricted_rpc']) {
      test(`maps denied ${path} for ${role}`, async () => {
        const response = await request(path, role)
        expect(response.status).toBe(role === 'anon' ? 401 : 403)
        expect(await response.json()).toMatchObject({ code: '42501', details: null, hint: null })
      })
    }
  }

  for (const role of ['anon', 'authenticated'] as const) {
    test(`maps rejected RLS writes for ${role} without committing data`, async () => {
      const response = await request('owner_items', role, { id: 2, owner_id: otherId })
      expect(response.status).toBe(role === 'anon' ? 401 : 403)
      expect(await response.json()).toMatchObject({ code: '42501' })
      const rows = await db!.query<{ id: number }>('select id from public.owner_items order by id')
      expect(rows.rows).toEqual([{ id: 1 }])
    })
  }

  test('does not turn an empty anonymous RLS result into an authentication error', async () => {
    const response = await request('owner_items', 'anon')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
  })

  test('keeps granted authenticated and service-role requests working after denials', async () => {
    expect((await request('restricted_items', 'anon')).status).toBe(401)
    const own = await request('owner_items', 'authenticated', { id: 2, owner_id: userId })
    expect(own.status).toBe(201)
    expect(await own.json()).toEqual([{ id: 2, owner_id: userId }])
    const service = await request('owner_items', 'service_role', { id: 3, owner_id: otherId })
    expect(service.status).toBe(201)
    expect(await service.json()).toEqual([{ id: 3, owner_id: otherId }])
  })

  test('preserves other REST status codes for anonymous requests', async () => {
    expect((await request('does_not_exist', 'anon')).status).toBe(404)
    expect((await request('rpc/does_not_exist', 'anon')).status).toBe(404)
    expect((await request('owner_items?select=id::bad-type', 'anon')).status).toBe(400)
  })

  test('keeps helper defaults, explicit ApiError statuses and PostgreSQL error fields', async () => {
    const denied = { code: '42501', message: 'denied', detail: 'restricted', hint: 'grant required' }
    expect(errorToResponse(denied).status).toBe(403)
    const anonymous = errorToResponse(denied, false)
    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).toEqual({
      code: '42501', message: 'denied', details: 'restricted', hint: 'grant required',
    })
    const explicit = new ApiError(403, { code: 'FORBIDDEN', message: 'denied', details: null, hint: null })
    expect(errorToResponse(explicit, false).status).toBe(403)
    expect(errorToResponse({ code: '23505', message: 'duplicate' }, false).status).toBe(409)
    expect(errorToResponse({ code: '25006', message: 'read only' }, false).status).toBe(405)
  })
})
