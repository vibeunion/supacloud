import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from '../src/runtime/db/database.js'
import { RestHandler } from '../src/runtime/rest/handler.js'

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('table and view read transaction access modes', () => {
  let db: Database | undefined
  let rest: RestHandler

  beforeAll(async () => {
    db = await Database.create()
    await db.exec(`
      create table public.table_read_probe (id integer primary key, visits integer not null default 0);
      insert into public.table_read_probe (id) values (1);
      create function public.write_during_read() returns integer language sql volatile
        as $$ update public.table_read_probe set visits = visits + 1 where id = 1 returning visits $$;
      create view public.write_view as select public.write_during_read() as visits;
      create view public.filtered_write_view as
        select id from public.table_read_probe where public.write_during_read() > 0;
      create sequence public.read_sequence;
      create view public.sequence_view as select nextval('public.read_sequence') as value;
      create view public.read_mode_probe as
        select current_setting('transaction_read_only') as read_only,
               current_user as role, auth.uid() as user_id;
      create table public.private_read_rows (id integer primary key, owner_id uuid not null);
      insert into public.private_read_rows values (1, '${userId}'), (2, '${otherId}');
      alter table public.private_read_rows enable row level security;
      create policy owner_read on public.private_read_rows for select to authenticated
        using (owner_id = auth.uid());
    `)
    rest = new RestHandler(db)
  }, 60_000)

  beforeEach(async () => {
    await db!.exec(`
      delete from public.table_read_probe where id <> 1;
      update public.table_read_probe set visits = 0;
      alter sequence public.read_sequence restart with 1;
    `)
  })

  afterAll(async () => {
    await db?.close()
  })

  function request(
    path: string,
    options: {
      method?: 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'DELETE'
      role?: 'anon' | 'authenticated' | 'service_role'
      accept?: string
      prefer?: string
      body?: Record<string, unknown>
    } = {}
  ) {
    const url = new URL(`http://lite.local/rest/v1/${path}`)
    const headers = new Headers({ 'content-type': 'application/json' })
    if (options.accept) headers.set('accept', options.accept)
    if (options.prefer) headers.set('prefer', options.prefer)
    const role = options.role ?? 'authenticated'
    return rest.handle(new Request(url, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    }), { role, claims: { role, ...(role === 'authenticated' ? { sub: userId } : {}) } }, url)
  }

  async function state() {
    const result = await db!.query<{ visits: number; is_called: boolean }>(`
      select visits, is_called from public.table_read_probe cross join public.read_sequence where id = 1
    `)
    return result.rows[0]!
  }

  for (const method of ['GET', 'HEAD'] as const) {
    for (const view of ['write_view', 'sequence_view'] as const) {
      test(`blocks ${method} side effects from ${view}`, async () => {
        const response = await request(view, { method })
        expect({ status: response.status, ...await state() }).toEqual({ status: 405, visits: 0, is_called: false })
        expect(await response.json()).toMatchObject({ code: '25006' })
      })
    }

    test(`blocks writes from the separate ${method} count query`, async () => {
      const response = await request('filtered_write_view?limit=0', { method, prefer: 'count=exact' })
      expect({ status: response.status, ...await state() }).toEqual({ status: 405, visits: 0, is_called: false })
      expect(await response.json()).toMatchObject({ code: '25006' })
    })

    for (const format of ['json', 'text'] as const) {
      test(`blocks ${method} EXPLAIN ANALYZE side effects with ${format} output`, async () => {
        const response = await request('write_view', {
          method, accept: `application/vnd.pgrst.plan+${format}; options=analyze`,
        })
        expect({ status: response.status, ...await state() }).toEqual({ status: 405, visits: 0, is_called: false })
        expect(await response.json()).toMatchObject({ code: '25006' })
      })
    }

    test(`preserves ${method} RLS filtering and counts`, async () => {
      const response = await request('private_read_rows?select=id&order=id', { method, prefer: 'count=exact' })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-range')).toBe('0-0/1')
      if (method === 'HEAD') expect(await response.text()).toBe('')
      else expect(await response.json()).toEqual([{ id: 1 }])
    })
  }

  test('applies read-only mode without losing the role or JWT context', async () => {
    const response = await request('read_mode_probe')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([{ read_only: 'on', role: 'authenticated', user_id: userId }])
    const anonymous = await request('private_read_rows?select=id', { role: 'anon' })
    expect(anonymous.status).toBe(200)
    expect(await anonymous.json()).toEqual([])
    const service = await request('private_read_rows?select=id&order=id', { role: 'service_role' })
    expect(service.status).toBe(200)
    expect(await service.json()).toEqual([{ id: 1 }, { id: 2 }])
  })

  test('does not exempt service_role reads from the read-only transaction', async () => {
    const response = await request('sequence_view', { role: 'service_role' })
    expect({ status: response.status, ...await state() }).toEqual({ status: 405, visits: 0, is_called: false })
    expect(await response.json()).toMatchObject({ code: '25006' })
  })

  test('allows ordinary EXPLAIN and read-only EXPLAIN ANALYZE', async () => {
    for (const [path, accept] of [
      ['write_view', 'application/vnd.pgrst.plan+json'],
      ['private_read_rows', 'application/vnd.pgrst.plan+json; options=analyze'],
      ['private_read_rows', 'application/vnd.pgrst.plan+text; options=analyze'],
    ] as const) {
      const response = await request(path, { accept })
      expect(response.status).toBe(200)
      expect((await response.text()).length).toBeGreaterThan(0)
      expect(await state()).toEqual({ visits: 0, is_called: false })
    }
  })

  test('preserves POST/PATCH/DELETE after successful and rejected reads', async () => {
    expect((await request('read_mode_probe')).status).toBe(200)
    const inserted = await request('table_read_probe', {
      method: 'POST', prefer: 'return=representation', body: { id: 2 },
    })
    expect(inserted.status).toBe(201)
    expect(await inserted.json()).toEqual([{ id: 2, visits: 0 }])
    expect((await request('write_view')).status).toBe(405)
    const updated = await request('table_read_probe?id=eq.2', {
      method: 'PATCH', prefer: 'return=representation', body: { visits: 7 },
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toEqual([{ id: 2, visits: 7 }])
    const deleted = await request('table_read_probe?id=eq.2', { method: 'DELETE', prefer: 'return=representation' })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual([{ id: 2, visits: 7 }])
    const remaining = await request('table_read_probe?order=id')
    expect(remaining.status).toBe(200)
    expect(await remaining.json()).toEqual([{ id: 1, visits: 0 }])
  })
})
