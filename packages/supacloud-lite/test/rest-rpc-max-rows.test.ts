import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from '../src/runtime/db/database.js'
import { RestHandler } from '../src/runtime/rest/handler.js'

describe('table-valued RPC response limits', () => {
  let db: Database | undefined
  let rest: RestHandler

  beforeAll(async () => {
    db = await Database.create()
    await db.exec(`
      create table public.rpc_limit_items (id integer primary key, visits integer not null default 0);
      insert into public.rpc_limit_items (id) select generate_series(1, 5);
      alter table public.rpc_limit_items enable row level security;
      create policy limited_read on public.rpc_limit_items for select to authenticated using (id <= 3);
      create function public.read_limit_items() returns setof public.rpc_limit_items
        language sql stable as $$ select * from public.rpc_limit_items $$;
      create function public.visit_limit_items() returns setof public.rpc_limit_items
        language sql volatile as $$ update public.rpc_limit_items set visits = visits + 1 returning * $$;
    `)
    rest = new RestHandler(db, { maxRows: 2 })
  }, 60_000)

  beforeEach(async () => {
    await db!.query('update public.rpc_limit_items set visits = 0')
  })

  afterAll(async () => {
    await db?.close()
  })

  function invoke(options: {
    handler?: RestHandler
    method?: 'GET' | 'HEAD' | 'POST'
    query?: string
    role?: 'authenticated' | 'service_role'
    write?: boolean
    count?: boolean
    accept?: string
  } = {}) {
    const name = options.write ? 'visit_limit_items' : 'read_limit_items'
    const url = new URL(`http://lite.local/rest/v1/rpc/${name}?order=id&${options.query ?? ''}`)
    const headers = new Headers({ 'content-type': 'application/json' })
    if (options.count !== false) headers.set('prefer', 'count=exact')
    if (options.accept) headers.set('accept', options.accept)
    const method = options.method ?? 'GET'
    const role = options.role ?? 'service_role'
    return (options.handler ?? rest).handle(new Request(url, {
      method, headers, ...(method === 'POST' ? { body: '{}' } : {}),
    }), { role, claims: { role } }, url)
  }

  async function visits() {
    const result = await db!.query<{ visits: number }>('select visits from public.rpc_limit_items order by id')
    return result.rows.map((row) => row.visits)
  }

  for (const method of ['GET', 'HEAD', 'POST'] as const) {
    for (const query of ['', 'limit=100']) {
      test(`caps ${method} results with ${query || 'no explicit limit'}`, async () => {
        const response = await invoke({ method, query })
        expect(response.status).toBe(200)
        expect(response.headers.get('content-range')).toBe('0-1/5')
        if (method === 'HEAD') expect(await response.text()).toBe('')
        else expect(await response.json()).toEqual([{ id: 1, visits: 0 }, { id: 2, visits: 0 }])
      })
    }
  }

  test('keeps smaller caller limits and offsets', async () => {
    const response = await invoke({ query: 'limit=1&offset=2' })
    expect(response.headers.get('content-range')).toBe('2-2/5')
    expect(await response.json()).toEqual([{ id: 3, visits: 0 }])
  })

  test('counts filtered RLS-visible rows before capping the response', async () => {
    const response = await invoke({ role: 'authenticated' })
    expect(response.headers.get('content-range')).toBe('0-1/3')
    expect(await response.json()).toEqual([{ id: 1, visits: 0 }, { id: 2, visits: 0 }])
    const filtered = await invoke({ query: 'id=gt.1&offset=1' })
    expect(filtered.headers.get('content-range')).toBe('1-2/4')
    expect(await filtered.json()).toEqual([{ id: 3, visits: 0 }, { id: 4, visits: 0 }])
  })

  test('caps uncounted and CSV responses', async () => {
    const response = await invoke({ count: false })
    expect(response.headers.get('content-range')).toBe('0-1/*')
    expect(await response.json()).toEqual([{ id: 1, visits: 0 }, { id: 2, visits: 0 }])
    const csv = await invoke({ accept: 'text/csv' })
    expect(csv.headers.get('content-range')).toBe('0-1/5')
    expect(await csv.text()).toBe('id,visits\n1,0\n2,0')
  })

  test('caps only the response, not a volatile function mutation', async () => {
    const response = await invoke({ write: true, method: 'POST' })
    expect(response.headers.get('content-range')).toBe('0-1/5')
    expect(await response.json()).toEqual([{ id: 1, visits: 1 }, { id: 2, visits: 1 }])
    expect(await visits()).toEqual([1, 1, 1, 1, 1])
  })

  test('allows a singular response capped to one row without replaying the mutation', async () => {
    const response = await invoke({
      handler: new RestHandler(db!, { maxRows: 1 }), write: true, method: 'POST',
      accept: 'application/vnd.pgrst.object+json',
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-range')).toBe('0-0/5')
    expect(await response.json()).toEqual({ id: 1, visits: 1 })
    expect(await visits()).toEqual([1, 1, 1, 1, 1])
  })

  test('still rolls back an invalid singular response', async () => {
    const response = await invoke({ write: true, method: 'POST', accept: 'application/vnd.pgrst.object+json' })
    expect(response.status).toBe(406)
    expect(await response.json()).toMatchObject({ code: 'PGRST116', details: 'The result contains 2 rows' })
    expect(await visits()).toEqual([0, 0, 0, 0, 0])
  })

  test('preserves counts with a zero row cap and allows uncapped configurations', async () => {
    const empty = await invoke({ handler: new RestHandler(db!, { maxRows: 0 }) })
    expect(empty.headers.get('content-range')).toBe('*/5')
    expect(await empty.json()).toEqual([])
    const unlimited = await invoke({ handler: new RestHandler(db!) })
    expect(unlimited.headers.get('content-range')).toBe('0-4/5')
    expect(await unlimited.json()).toHaveLength(5)
  })
})
