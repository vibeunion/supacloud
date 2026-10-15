import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from '../src/runtime/db/database.js'
import { RestHandler } from '../src/runtime/rest/handler.js'

describe('table-valued RPC Range headers', () => {
  let db: Database | undefined
  let rest: RestHandler

  beforeAll(async () => {
    db = await Database.create()
    await db.exec(`
      create table public.rpc_range_items (id integer primary key);
      insert into public.rpc_range_items select generate_series(1, 5);
      create function public.range_items(minimum integer default 1) returns setof public.rpc_range_items
        language sql stable as $$ select * from public.rpc_range_items where id >= minimum $$;
    `)
    rest = new RestHandler(db)
  }, 60_000)

  afterAll(async () => {
    await db?.close()
  })

  function invoke(options: {
    method?: 'GET' | 'HEAD' | 'POST'
    query?: string
    range?: string
    unit?: string
    handler?: RestHandler
    accept?: string
  } = {}) {
    const method = options.method ?? 'GET'
    const url = new URL(`http://lite.local/rest/v1/rpc/range_items?order=id&${options.query ?? ''}`)
    const headers = new Headers({ 'content-type': 'application/json', prefer: 'count=exact' })
    if (options.range !== undefined) headers.set('range', options.range)
    if (options.unit !== undefined) headers.set('range-unit', options.unit)
    if (options.accept) headers.set('accept', options.accept)
    return (options.handler ?? rest).handle(new Request(url, {
      method, headers, ...(method === 'POST' ? { body: '{"minimum":2}' } : {}),
    }), { role: 'service_role', claims: { role: 'service_role' } }, url)
  }

  for (const method of ['GET', 'HEAD'] as const) {
    test(`applies a bounded Range on ${method} after collecting named arguments`, async () => {
      const response = await invoke({ method, query: 'minimum=2', range: '1-2', unit: 'items' })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-range')).toBe('1-2/4')
      if (method === 'HEAD') expect(await response.text()).toBe('')
      else expect(await response.json()).toEqual([{ id: 3 }, { id: 4 }])
    })

    test(`caps a ${method} Range using the configured maxRows`, async () => {
      const response = await invoke({
        method, range: '1-4', handler: new RestHandler(db!, { maxRows: 2 }),
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-range')).toBe('1-2/5')
      if (method === 'HEAD') expect(await response.text()).toBe('')
      else expect(await response.json()).toEqual([{ id: 2 }, { id: 3 }])
    })
  }

  test('accepts an open-ended range without a Range-Unit header', async () => {
    const response = await invoke({ range: '3-' })
    expect(response.headers.get('content-range')).toBe('3-4/5')
    expect(await response.json()).toEqual([{ id: 4 }, { id: 5 }])
  })

  test('keeps query parameter precedence consistent with table reads', async () => {
    const response = await invoke({ query: 'offset=2&limit=1', range: '0-4' })
    expect(response.headers.get('content-range')).toBe('2-2/5')
    expect(await response.json()).toEqual([{ id: 3 }])
  })

  test('supports a single-row Range with singular and CSV representations', async () => {
    const single = await invoke({ range: '2-2', accept: 'application/vnd.pgrst.object+json' })
    expect(single.status).toBe(200)
    expect(single.headers.get('content-range')).toBe('2-2/5')
    expect(await single.json()).toEqual({ id: 3 })
    const csv = await invoke({ range: '2-2', accept: 'text/csv' })
    expect(csv.headers.get('content-range')).toBe('2-2/5')
    expect(await csv.text()).toBe('id\n3')
  })

  for (const range of ['2-1', '-1-2', 'invalid', '0-9007199254740992']) {
    test(`uses the table parser to reject an invalid Range: ${range}`, async () => {
      const response = await invoke({ range })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'PGRST100' })
    })
  }

  test('rejects unsupported range units', async () => {
    const response = await invoke({ range: '0-1', unit: 'bytes' })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'PGRST100' })
  })

  test('leaves POST Range headers ignored and no-header reads unchanged', async () => {
    const post = await invoke({ method: 'POST', range: '2-1' })
    expect(post.status).toBe(200)
    expect(post.headers.get('content-range')).toBe('0-3/4')
    expect(await post.json()).toEqual([{ id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }])
    const get = await invoke()
    expect(get.status).toBe(200)
    expect(get.headers.get('content-range')).toBe('0-4/5')
    expect(await get.json()).toHaveLength(5)
  })
})
