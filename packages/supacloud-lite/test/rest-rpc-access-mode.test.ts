import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from '../src/runtime/db/database.js'
import { RestHandler } from '../src/runtime/rest/handler.js'

const writers = [
  { name: 'write_void', status: 204, result: null },
  { name: 'write_scalar', status: 200, result: 1 },
  { name: 'write_scalar_set', status: 200, result: [1] },
  { name: 'write_rows', status: 200, result: [{ id: 1, visits: 1 }] },
] as const

describe('RPC transaction access modes', () => {
  let db: Database | undefined
  let rest: RestHandler

  beforeAll(async () => {
    db = await Database.create()
    await db.exec(`
      create table public.rpc_access_probe (
        id integer primary key,
        visits integer not null default 0
      );
      insert into public.rpc_access_probe (id) values (1);
      grant select, update on public.rpc_access_probe to authenticated;

      create function public.write_void() returns void
        language sql volatile security invoker
        as $$ update public.rpc_access_probe set visits = visits + 1 $$;
      create function public.write_scalar() returns integer
        language sql volatile security invoker
        as $$ update public.rpc_access_probe set visits = visits + 1 returning visits $$;
      create function public.write_scalar_set() returns setof integer
        language sql volatile security invoker
        as $$ update public.rpc_access_probe set visits = visits + 1 returning visits $$;
      create function public.write_rows() returns setof public.rpc_access_probe
        language sql volatile security invoker
        as $$ update public.rpc_access_probe set visits = visits + 1 returning * $$;

      create function public.stable_write() returns integer
        language sql stable as $$ select public.write_scalar() $$;
      create function public.immutable_write() returns integer
        language sql immutable as $$ select public.write_scalar() $$;

      create function public.mode_volatile() returns text language sql volatile
        as $$ select current_setting('transaction_read_only') $$;
      create function public.mode_stable() returns text language sql stable
        as $$ select current_setting('transaction_read_only') $$;
      create function public.mode_immutable() returns text language sql immutable
        as $$ select current_setting('transaction_read_only') $$;

      create function public.read_rows() returns setof public.rpc_access_probe
        language sql stable as $$ select * from public.rpc_access_probe $$;
      create function public.read_scalar_set() returns setof integer
        language sql stable as $$ select visits from public.rpc_access_probe $$;
      create function public.read_void() returns void language sql stable as $$ select 1 $$;
    `)
    rest = new RestHandler(db)
  }, 60_000)

  beforeEach(async () => {
    await db!.query('update public.rpc_access_probe set visits = 0')
  })

  afterAll(async () => {
    await db?.engine.close()
  })

  function invoke(name: string, method: 'GET' | 'HEAD' | 'POST', count = false) {
    const url = new URL(`http://lite.local/rest/v1/rpc/${name}`)
    const headers = new Headers({ 'content-type': 'application/json' })
    if (count) headers.set('prefer', 'count=exact')
    const request = new Request(url, { method, headers, ...(method === 'POST' ? { body: '{}' } : {}) })
    return rest.handle(request, { role: 'authenticated', claims: { role: 'authenticated' } }, url)
  }

  async function visits() {
    const result = await db!.query<{ visits: number }>('select visits from public.rpc_access_probe')
    return result.rows[0]!.visits
  }

  for (const writer of writers) {
    for (const method of ['GET', 'HEAD'] as const) {
      test(`rejects ${method} writes returning ${writer.name}`, async () => {
        const response = await invoke(writer.name, method)
        expect({ status: response.status, visits: await visits() }).toEqual({ status: 405, visits: 0 })
        expect(await response.json()).toMatchObject({ code: '25006' })
      })
    }

    test(`allows POST writes returning ${writer.name}`, async () => {
      const response = await invoke(writer.name, 'POST')
      expect(response.status).toBe(writer.status)
      if (writer.status === 204) expect(await response.text()).toBe('')
      else expect(await response.json()).toEqual(writer.result)
      expect(await visits()).toBe(1)
    })
  }

  for (const volatility of ['stable', 'immutable'] as const) {
    test(`rejects POST writes hidden behind a ${volatility} wrapper`, async () => {
      const response = await invoke(`${volatility}_write`, 'POST')
      expect({ status: response.status, visits: await visits() }).toEqual({ status: 405, visits: 0 })
      expect(await response.json()).toMatchObject({ code: '25006' })
    })
  }

  for (const volatility of ['volatile', 'stable', 'immutable'] as const) {
    for (const method of ['GET', 'HEAD', 'POST'] as const) {
      test(`allows ${method} reads from a ${volatility} function`, async () => {
        const response = await invoke(`mode_${volatility}`, method)
        expect(response.status).toBe(200)
        if (method !== 'HEAD') {
          expect(await response.json()).toBe(method === 'POST' && volatility === 'volatile' ? 'off' : 'on')
        }
        expect(await visits()).toBe(0)
      })
    }
  }

  test('keeps read-only table, scalar-set and void RPC branches working', async () => {
    const rows = await invoke('read_rows', 'GET', true)
    expect(rows.status).toBe(200)
    expect(rows.headers.get('content-range')).toBe('0-0/1')
    expect(await rows.json()).toEqual([{ id: 1, visits: 0 }])
    const scalars = await invoke('read_scalar_set', 'GET')
    expect(scalars.status).toBe(200)
    expect(await scalars.json()).toEqual([0])
    const empty = await invoke('read_void', 'GET')
    expect(empty.status).toBe(204)
    expect(await empty.text()).toBe('')
  })

  test('does not leak the access mode after successful or rejected reads', async () => {
    expect((await invoke('read_rows', 'GET')).status).toBe(200)
    expect((await invoke('write_rows', 'POST', true)).status).toBe(200)
    expect(await visits()).toBe(1)
    expect((await invoke('write_rows', 'HEAD', true)).status).toBe(405)
    expect(await visits()).toBe(1)
    expect((await invoke('write_rows', 'POST', true)).status).toBe(200)
    expect(await visits()).toBe(2)
  })
})
