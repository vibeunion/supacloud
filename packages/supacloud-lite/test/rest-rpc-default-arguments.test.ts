import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from '../src/runtime/db/database.js'
import { RestHandler } from '../src/runtime/rest/handler.js'

describe('RPC required and default argument matching', () => {
  let db: Database | undefined
  let rest: RestHandler

  beforeAll(async () => {
    db = await Database.create()
    await db.exec(`
      create table public.default_calls (value text not null);
      create function public.required_value(value integer, extra integer default 2) returns integer
        language sql stable as $$ select value + extra $$;
      create function public.optional_value(first integer default 3, second integer default 4)
        returns integer language sql stable as $$ select first + second $$;
      create function public.no_args() returns integer language sql stable as $$ select 9 $$;

      create function public.default_ambiguous(value integer, extra integer default 1)
        returns text language sql stable as $$ select 'integer'::text $$;
      create function public.default_ambiguous(value text, suffix text default '!')
        returns text language sql stable as $$ select 'text'::text $$;
      create function public.exact_and_default(value integer) returns text
        language plpgsql volatile as $$ begin
          insert into public.default_calls values ('exact'); return 'exact';
        end $$;
      create function public.exact_and_default(value text, suffix text default '!')
        returns text language plpgsql volatile as $$ begin
          insert into public.default_calls values ('default'); return 'default';
        end $$;

      create function public.choose_default(value integer, missing integer) returns integer
        language sql stable as $$ select value + missing $$;
      create function public.choose_default(value integer, label text default 'chosen')
        returns text language plpgsql volatile as $$ begin
          insert into public.default_calls values (label); return label;
        end $$;

      create function public.output_default(
        value integer, out result integer, extra integer default 2
      ) language sql stable as $$ select value + extra $$;
      create function public.echo_text("value with space" text default 'hello, world')
        returns text language sql stable as $$ select "value with space" $$;
      create function public.table_default(value integer default 6)
        returns table(result integer, label text) language sql stable as $$ select value, 'row'::text $$;
      create function public.inout_default(inout value integer, extra integer default 2)
        language plpgsql stable as $$ begin value := value + extra; end $$;
      create function public.full_ambiguous(value integer) returns integer
        language sql stable as $$ select value $$;
      create function public.full_ambiguous(value text) returns text
        language sql stable as $$ select value $$;
    `)
    rest = new RestHandler(db)
  }, 60_000)

  beforeEach(async () => {
    await db!.query('delete from public.default_calls')
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

  const missingArguments: Record<string, number>[] = [{}, { extra: 5 }]
  for (const method of ['GET', 'HEAD', 'POST'] as const) {
    for (const args of missingArguments) {
      test(`rejects missing required arguments on ${method} with ${JSON.stringify(args)}`, async () => {
        const response = await invoke('required_value', method, args)
        expect(response.status).toBe(404)
        expect(await response.json()).toMatchObject({ code: 'PGRST202' })
      })
    }

    for (const name of ['default_ambiguous', 'exact_and_default']) {
      test(`rejects multiple applicable signatures for ${name} on ${method}`, async () => {
        const response = await invoke(name, method, { value: 1 })
        expect(response.status).toBe(300)
        expect(await response.json()).toMatchObject({ code: 'PGRST203' })
        expect((await db!.query('select * from public.default_calls')).rows).toEqual([])
      })
    }
  }

  for (const method of ['GET', 'POST'] as const) {
    test(`accepts omitted defaults and explicit values on ${method}`, async () => {
      const omitted = await invoke('required_value', method, { value: 5 })
      expect(omitted.status).toBe(200)
      expect(await omitted.json()).toBe(7)
      const explicit = await invoke('required_value', method, { value: 5, extra: 4 })
      expect(explicit.status).toBe(200)
      expect(await explicit.json()).toBe(9)
    })

    test(`accepts all defaults or a non-leading optional argument on ${method}`, async () => {
      const omitted = await invoke('optional_value', method)
      expect(omitted.status).toBe(200)
      expect(await omitted.json()).toBe(7)
      const partial = await invoke('optional_value', method, { second: 8 })
      expect(partial.status).toBe(200)
      expect(await partial.json()).toBe(11)
    })
  }

  test('selects the only applicable defaulted overload with its own volatility', async () => {
    const response = await invoke('choose_default', 'POST', { value: 5 })
    expect(response.status).toBe(200)
    expect(await response.json()).toBe('chosen')
    expect((await db!.query('select * from public.default_calls')).rows).toEqual([{ value: 'chosen' }])
  })

  test('keeps a fully specified overload callable and counts explicit null as supplied', async () => {
    const explicit = await invoke('default_ambiguous', 'POST', { value: 1, extra: 4 })
    expect(explicit.status).toBe(200)
    expect(await explicit.json()).toBe('integer')
    const nullable = await invoke('required_value', 'POST', { value: null })
    expect(nullable.status).toBe(200)
    expect(await nullable.json()).toBeNull()
  })

  test('preserves no-argument calls and rejects unknown POST keys', async () => {
    const empty = await invoke('no_args', 'POST')
    expect(empty.status).toBe(200)
    expect(await empty.json()).toBe(9)
    const unknown = await invoke('optional_value', 'POST', { unknown: 1 })
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ code: 'PGRST202' })
  })

  test('does not treat OUT arguments as required inputs', async () => {
    const omitted = await invoke('output_default', 'POST', { value: 5 })
    expect(omitted.status).toBe(200)
    expect(await omitted.json()).toBe(7)
    const explicit = await invoke('output_default', 'POST', { value: 5, extra: 4 })
    expect(explicit.status).toBe(200)
    expect(await explicit.json()).toBe(9)
  })

  test('reads quoted input names without parsing default expressions', async () => {
    const omitted = await invoke('echo_text', 'POST')
    expect(omitted.status).toBe(200)
    expect(await omitted.json()).toBe('hello, world')
    const explicit = await invoke('echo_text', 'POST', { 'value with space': 'custom' })
    expect(explicit.status).toBe(200)
    expect(await explicit.json()).toBe('custom')
  })

  test('excludes TABLE output columns from optional input matching', async () => {
    const omitted = await invoke('table_default', 'POST')
    expect(omitted.status).toBe(200)
    expect(await omitted.json()).toEqual([{ result: 6, label: 'row' }])
    const explicit = await invoke('table_default', 'POST', { value: 8 })
    expect(explicit.status).toBe(200)
    expect(await explicit.json()).toEqual([{ result: 8, label: 'row' }])
  })

  test('retains INOUT arguments as required inputs', async () => {
    const missing = await invoke('inout_default', 'POST')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ code: 'PGRST202' })
    const present = await invoke('inout_default', 'POST', { value: 5 })
    expect(present.status).toBe(200)
    expect(await present.json()).toBe(7)
  })

  test('still rejects complete named type overload ambiguity', async () => {
    const response = await invoke('full_ambiguous', 'POST', { value: 1 })
    expect(response.status).toBe(300)
    expect(await response.json()).toMatchObject({ code: 'PGRST203' })
  })
})
