import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from '../src/runtime/db/database.js'
import { RestHandler } from '../src/runtime/rest/handler.js'

describe('RPC overload ambiguity with complete named arguments', () => {
  let db: Database | undefined
  let rest: RestHandler

  beforeAll(async () => {
    db = await Database.create()
    await db.exec(`
      create table public.overload_calls (value text not null);
      create function public.ambiguous_value(value integer) returns text
        language plpgsql volatile as $$ begin
          insert into public.overload_calls values ('integer');
          return 'integer';
        end $$;
      create function public.ambiguous_value(value text) returns text
        language plpgsql volatile as $$ begin
          insert into public.overload_calls values ('text');
          return 'text';
        end $$;
      create function public.named_value(number_value integer) returns text
        language sql stable as $$ select 'number:' || number_value::text $$;
      create function public.named_value(text_value text) returns text
        language sql stable as $$ select 'text:' || text_value $$;
      create function public.arity_value(value integer) returns integer
        language sql stable as $$ select value $$;
      create function public.arity_value(value integer, extra integer) returns integer
        language sql stable as $$ select value + extra $$;
      create function public.default_value(value integer default 7) returns integer
        language sql stable as $$ select value $$;
      create function public.reordered_value(first integer, second text) returns text
        language sql stable as $$ select 'integer-text'::text $$;
      create function public.reordered_value(second text, first bigint) returns text
        language sql stable as $$ select 'text-bigint'::text $$;
    `)
    rest = new RestHandler(db)
  }, 60_000)

  beforeEach(async () => {
    await db!.query('delete from public.overload_calls')
  })

  afterAll(async () => {
    await db?.close()
  })

  function invoke(
    name: string,
    method: 'GET' | 'HEAD' | 'POST',
    args: Record<string, string | number | null> = {},
  ) {
    const url = new URL(`http://lite.local/rest/v1/rpc/${name}`)
    if (method !== 'POST') {
      for (const [key, value] of Object.entries(args)) url.searchParams.set(key, String(value))
    }
    return rest.handle(new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify(args) } : {}),
    }), { role: 'service_role', claims: { role: 'service_role' } }, url)
  }

  for (const method of ['GET', 'HEAD', 'POST'] as const) {
    test(`rejects same-name type overloads before execution on ${method}`, async () => {
      const response = await invoke('ambiguous_value', method, { value: 1 })
      expect(response.status).toBe(300)
      expect(await response.json()).toMatchObject({
        code: 'PGRST203',
        details: null,
        hint: expect.stringContaining('renaming'),
        message: expect.stringContaining('public.ambiguous_value(value => integer)'),
      })
      const calls = await db!.query('select * from public.overload_calls')
      expect(calls.rows).toEqual([])
    })
  }

  for (const value of ['not-an-integer', null]) {
    test(`does not infer a POST overload from the JSON value ${JSON.stringify(value)}`, async () => {
      const response = await invoke('ambiguous_value', 'POST', { value })
      expect(response.status).toBe(300)
      const body = await response.json()
      expect(body.code).toBe('PGRST203')
      expect(body.message).toContain('public.ambiguous_value(value => text)')
      expect((await db!.query('select * from public.overload_calls')).rows).toEqual([])
    })
  }

  test('matches argument names independently of declaration or request order', async () => {
    const response = await invoke('reordered_value', 'POST', { second: '2', first: '1' })
    expect(response.status).toBe(300)
    expect(await response.json()).toMatchObject({ code: 'PGRST203' })
  })

  for (const method of ['GET', 'POST'] as const) {
    test(`keeps overloads with distinct parameter names callable on ${method}`, async () => {
      const number = await invoke('named_value', method, { number_value: 4 })
      expect(number.status).toBe(200)
      expect(await number.json()).toBe('number:4')
      const text = await invoke('named_value', method, { text_value: 'hello' })
      expect(text.status).toBe(200)
      expect(await text.json()).toBe('text:hello')
    })

    test(`keeps overloads with distinct parameter counts callable on ${method}`, async () => {
      const single = await invoke('arity_value', method, { value: 4 })
      expect(single.status).toBe(200)
      expect(await single.json()).toBe(4)
      const pair = await invoke('arity_value', method, { value: 4, extra: 3 })
      expect(pair.status).toBe(200)
      expect(await pair.json()).toBe(7)
    })
  }

  test('preserves default arguments for a single candidate', async () => {
    const response = await invoke('default_value', 'POST')
    expect(response.status).toBe(200)
    expect(await response.json()).toBe(7)
  })

  test('preserves unknown POST argument errors without executing a candidate', async () => {
    const response = await invoke('ambiguous_value', 'POST', { unknown: 1 })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'PGRST202' })
    expect((await db!.query('select * from public.overload_calls')).rows).toEqual([])
  })
})
