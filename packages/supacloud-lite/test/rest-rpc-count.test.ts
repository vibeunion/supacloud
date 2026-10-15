import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from '../src/runtime/db/database.js'
import { RestHandler } from '../src/runtime/rest/handler.js'

/** Real PGlite queries: a second function call increments every row again. */
describe('REST counted RPC transaction boundary', () => {
  let db: Database | undefined
  let rest: RestHandler

  beforeAll(async () => {
    db = await Database.create()
    await db.exec(`
      create table public.rpc_count_probe (
        id integer primary key,
        visits integer not null default 0
      );
      insert into public.rpc_count_probe (id) values (1), (2), (3);
      create function public.visit_count_probe()
        returns setof public.rpc_count_probe
        language sql volatile security invoker
        as $$
          update public.rpc_count_probe set visits = visits + 1 returning *;
        $$;
      grant select, update on public.rpc_count_probe to service_role;
      grant execute on function public.visit_count_probe() to service_role;
    `)
    rest = new RestHandler(db)
  }, 60_000)

  beforeEach(async () => {
    await db!.query('update public.rpc_count_probe set visits = 0')
  })

  afterAll(async () => {
    await db?.engine.close()
  })

  function invoke(query = '', options: { count?: string; single?: boolean; csv?: boolean } = {}) {
    const url = new URL(`http://lite.local/rest/v1/rpc/visit_count_probe${query}`)
    const headers = new Headers({ 'content-type': 'application/json' })
    if (options.count) headers.set('prefer', `count=${options.count}`)
    if (options.single) headers.set('accept', 'application/vnd.pgrst.object+json')
    if (options.csv) headers.set('accept', 'text/csv')
    const request = new Request(url, { method: 'POST', headers, body: '{}' })
    return rest.handle(request, { role: 'service_role', claims: null }, url)
  }

  async function visits() {
    const result = await db!.query<{ visits: number }>('select visits from public.rpc_count_probe order by id')
    return result.rows.map((row) => row.visits)
  }

  for (const count of ['exact', 'planned', 'estimated']) {
    test(`executes a write RPC once with count=${count}`, async () => {
      const response = await invoke('?order=id.asc', { count })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-range')).toBe('0-2/3')
      expect(await response.json()).toEqual([
        { id: 1, visits: 1 }, { id: 2, visits: 1 }, { id: 3, visits: 1 },
      ])
      expect(await visits()).toEqual([1, 1, 1])
    })
  }

  test('counts filtered rows before pagination without replaying the function', async () => {
    const response = await invoke('?id=gt.1&order=id.asc&limit=1&offset=1', { count: 'exact' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-range')).toBe('1-1/2')
    expect(await response.json()).toEqual([{ id: 3, visits: 1 }])
    expect(await visits()).toEqual([1, 1, 1])
  })

  test('preserves the total when pagination returns no rows', async () => {
    const response = await invoke('?order=id.asc&offset=10', { count: 'exact' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-range')).toBe('*/3')
    expect(await response.json()).toEqual([])
    expect(await visits()).toEqual([1, 1, 1])
  })

  test('returns a zero count when filtering removes all results', async () => {
    const response = await invoke('?id=eq.999', { count: 'exact' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-range')).toBe('*/0')
    expect(await response.json()).toEqual([])
    expect(await visits()).toEqual([1, 1, 1])
  })

  test('commits a valid counted singular response exactly once', async () => {
    const response = await invoke('?order=id.asc&limit=1', { count: 'exact', single: true })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-range')).toBe('0-0/3')
    expect(await response.json()).toEqual({ id: 1, visits: 1 })
    expect(await visits()).toEqual([1, 1, 1])
  })

  for (const [query, rows] of [['', 3], ['?id=eq.999', 0]] as const) {
    test(`rolls back a counted singular response with ${rows} rows`, async () => {
      const response = await invoke(query, { count: 'exact', single: true })
      expect(response.status).toBe(406)
      expect(await response.json()).toMatchObject({
        code: 'PGRST116', details: `The result contains ${rows} rows`,
      })
      expect(await visits()).toEqual([0, 0, 0])
    })
  }

  test('keeps counted CSV output free of transport metadata', async () => {
    const response = await invoke('?order=id.asc&limit=1', { count: 'exact', csv: true })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-range')).toBe('0-0/3')
    expect(await response.text()).toBe('id,visits\n1,1')
    expect(await visits()).toEqual([1, 1, 1])
  })

  test('keeps uncounted RPC behavior unchanged', async () => {
    const response = await invoke('?order=id.asc')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-range')).toBe('0-2/*')
    expect(await response.json()).toEqual([
      { id: 1, visits: 1 }, { id: 2, visits: 1 }, { id: 3, visits: 1 },
    ])
    expect(await visits()).toEqual([1, 1, 1])
  })
})
