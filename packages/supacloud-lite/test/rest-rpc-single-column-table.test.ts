import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from '../src/runtime/db/database.js'
import { RestHandler } from '../src/runtime/rest/handler.js'

describe('single-column RETURNS TABLE RPC results', () => {
  let db: Database | undefined
  let rest: RestHandler

  beforeAll(async () => {
    db = await Database.create()
    await db.exec(`
      create table public.column_items (id integer primary key, visits integer not null default 0);
      insert into public.column_items (id) values (1), (2), (3);
      alter table public.column_items enable row level security;
      create policy column_read on public.column_items for select to authenticated using (id <= 2);
      create function public.read_column(minimum integer default 1) returns table(id integer)
        language sql stable as $$ select id from public.column_items where id >= minimum order by id $$;
      create function public.write_column() returns table(id integer)
        language sql volatile as $$ update public.column_items set visits = visits + 1 returning id $$;
      create function public.json_column() returns table(payload jsonb)
        language sql stable as $$ values (null::jsonb), ('{"a":1}'::jsonb) $$;
      create type public.column_state as enum ('ready');
      create domain public.column_number as integer check (value > 0);
      create function public.enum_column() returns table(value public.column_state)
        language sql stable as $$ select 'ready'::public.column_state $$;
      create function public.domain_column() returns table(value public.column_number)
        language sql stable as $$ select 7::public.column_number $$;
      create function public.scalar_value() returns integer
        language sql stable as $$ select 7 $$;
      create function public.scalar_values() returns setof integer
        language sql stable as $$ values (1), (2) $$;
      create function public.multiple_columns() returns table(id integer, label text)
        language sql stable as $$ select 1, 'row'::text $$;
    `)
    rest = new RestHandler(db)
  }, 60_000)

  beforeEach(async () => {
    await db!.query('update public.column_items set visits = 0')
  })

  afterAll(async () => {
    await db?.close()
  })

  function invoke(options: {
    name?: string
    method?: 'GET' | 'HEAD' | 'POST'
    query?: string
    body?: Record<string, number>
    role?: 'authenticated' | 'service_role'
    handler?: RestHandler
    range?: string
    accept?: string
    count?: boolean
  } = {}) {
    const url = new URL(`http://lite.local/rest/v1/rpc/${options.name ?? 'read_column'}?${options.query ?? ''}`)
    const method = options.method ?? 'GET'
    const role = options.role ?? 'service_role'
    const headers = new Headers({ 'content-type': 'application/json' })
    if (options.count !== false) headers.set('prefer', 'count=exact')
    if (options.accept) headers.set('accept', options.accept)
    if (options.range) headers.set('range', options.range)
    return (options.handler ?? rest).handle(new Request(url, {
      method, headers, ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}),
    }), { role, claims: { role } }, url)
  }

  async function visits() {
    const result = await db!.query<{ visits: number }>('select visits from public.column_items order by id')
    return result.rows.map((row) => row.visits)
  }

  for (const method of ['GET', 'HEAD', 'POST'] as const) {
    test(`preserves the declared column name and count on ${method}`, async () => {
      const response = await invoke({ method })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-range')).toBe('0-2/3')
      if (method === 'HEAD') expect(await response.text()).toBe('')
      else expect(await response.json()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
    })
  }

  test('applies selection aliases, filters, order and pagination before serialization', async () => {
    const response = await invoke({ query: 'select=chosen:id&id=gt.1&order=id.desc&limit=1&offset=1' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-range')).toBe('1-1/2')
    expect(await response.json()).toEqual([{ chosen: 2 }])
  })

  test('uses Range with maxRows without truncating the total count', async () => {
    const response = await invoke({ range: '1-2', handler: new RestHandler(db!, { maxRows: 1 }) })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-range')).toBe('1-1/3')
    expect(await response.json()).toEqual([{ id: 2 }])
  })

  test('counts only RLS-visible rows', async () => {
    const response = await invoke({ role: 'authenticated' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-range')).toBe('0-1/2')
    expect(await response.json()).toEqual([{ id: 1 }, { id: 2 }])
  })

  test('keeps named default arguments separate from output filters', async () => {
    const response = await invoke({ method: 'POST', body: { minimum: 2 }, query: 'id=lt.3' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([{ id: 2 }])
  })

  test('supports singular and CSV representations', async () => {
    const single = await invoke({ query: 'id=eq.2', accept: 'application/vnd.pgrst.object+json' })
    expect(single.status).toBe(200)
    expect(await single.json()).toEqual({ id: 2 })
    const csv = await invoke({ accept: 'text/csv', count: false })
    expect(csv.headers.get('content-type')).toContain('text/csv')
    expect(csv.headers.get('content-range')).toBe('0-2/*')
    expect(await csv.text()).toBe('id\n1\n2\n3')
  })

  test('keeps empty table results empty and rejects an empty singular result', async () => {
    const empty = await invoke({ query: 'id=gt.3' })
    expect(empty.headers.get('content-range')).toBe('*/0')
    expect(await empty.json()).toEqual([])
    const single = await invoke({ query: 'id=gt.3', accept: 'application/vnd.pgrst.object+json' })
    expect(single.status).toBe(406)
    expect(await single.json()).toMatchObject({ code: 'PGRST116' })
  })

  test('preserves a JSON column wrapper, including SQL null', async () => {
    const response = await invoke({ name: 'json_column' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([{ payload: null }, { payload: { a: 1 } }])
  })

  for (const [name, value] of [['enum_column', 'ready'], ['domain_column', 7]] as const) {
    test(`preserves the output column for ${name}`, async () => {
      const response = await invoke({ name })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([{ value }])
    })
  }

  test('caps a write response and counts it without replaying or truncating writes', async () => {
    const response = await invoke({
      name: 'write_column', method: 'POST', query: 'order=id',
      handler: new RestHandler(db!, { maxRows: 1 }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-range')).toBe('0-0/3')
    expect(await response.json()).toEqual([{ id: 1 }])
    expect(await visits()).toEqual([1, 1, 1])
  })

  test('rolls back writes when a singular result has multiple rows', async () => {
    const response = await invoke({
      name: 'write_column', method: 'POST', accept: 'application/vnd.pgrst.object+json',
    })
    expect(response.status).toBe(406)
    expect(await response.json()).toMatchObject({ code: 'PGRST116' })
    expect(await visits()).toEqual([0, 0, 0])
  })

  for (const method of ['GET', 'HEAD'] as const) {
    test(`keeps writing table functions read-only on ${method}`, async () => {
      const response = await invoke({ name: 'write_column', method })
      expect(response.status).toBe(405)
      expect(await visits()).toEqual([0, 0, 0])
    })
  }

  test('preserves scalar, scalar-set and multi-column table response shapes', async () => {
    for (const [name, expected] of [
      ['scalar_value', 7],
      ['scalar_values', [1, 2]],
      ['multiple_columns', [{ id: 1, label: 'row' }]],
    ] as const) {
      const response = await invoke({ name })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(expected)
    }
  })
})
