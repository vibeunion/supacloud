import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from '../src/runtime/db/database.js'
import { errorToResponse, statusForSqlState } from '../src/runtime/rest/errors.js'
import { RestHandler } from '../src/runtime/rest/handler.js'

describe('REST PL/pgSQL failure status mapping', () => {
  let db: Database | undefined
  let rest: RestHandler

  beforeAll(async () => {
    db = await Database.create()
    await db.exec(`
      set plpgsql.check_asserts = on;
      create table public.plpgsql_error_log (id integer);
      create function public.strict_rows(row_count integer) returns integer
        language plpgsql stable as $$ declare result integer; begin
          select n into strict result from generate_series(1, row_count) as n;
          return result;
        end $$;
      create function public.assertion_failure() returns integer
        language plpgsql stable as $$ begin
          assert false, 'PL/pgSQL assertion failed';
          return 1;
        end $$;
      create function public.business_failure() returns integer
        language plpgsql stable as $$ begin
          raise exception 'Business rule rejected'
            using detail = 'Invalid operation', hint = 'Choose another operation';
        end $$;
      create function public.write_then_strict(row_count integer) returns integer
        language plpgsql volatile as $$ begin
          insert into public.plpgsql_error_log values (1);
          return public.strict_rows(row_count);
        end $$;
      create table public.plpgsql_guard (id integer);
      create function public.reject_plpgsql_write() returns trigger
        language plpgsql as $$ begin
          insert into public.plpgsql_error_log values (2);
          perform public.strict_rows(0);
          return new;
        end $$;
      create trigger plpgsql_guard_insert after insert on public.plpgsql_guard
        for each row execute function public.reject_plpgsql_write();
    `)
    rest = new RestHandler(db)
  }, 60_000)

  beforeEach(async () => {
    await db!.query('delete from public.plpgsql_error_log')
    await db!.query('delete from public.plpgsql_guard')
  })

  afterAll(async () => {
    await db?.close()
  })

  function invoke(
    path: string,
    args: Record<string, number>,
    method: 'GET' | 'HEAD' | 'POST' = 'POST',
    role: 'anon' | 'authenticated' | 'service_role' = 'service_role',
  ) {
    const url = new URL(`http://lite.local/rest/v1/${path}`)
    if (method !== 'POST') {
      for (const [key, value] of Object.entries(args)) url.searchParams.set(key, String(value))
    }
    return rest.handle(new Request(url, {
      method, headers: { 'content-type': 'application/json', prefer: 'return=representation' },
      ...(method === 'POST' ? { body: JSON.stringify(args) } : {}),
    }), { role, claims: { role } }, url)
  }

  const failures: ReadonlyArray<{
    name: string
    args: Record<string, number>
    code: string
    message: string
  }> = [
    { name: 'strict_rows', args: { row_count: 0 }, code: 'P0002', message: 'query returned no rows' },
    { name: 'strict_rows', args: { row_count: 2 }, code: 'P0003', message: 'query returned more than one row' },
    { name: 'assertion_failure', args: {}, code: 'P0004', message: 'PL/pgSQL assertion failed' },
  ]

  for (const method of ['GET', 'HEAD', 'POST'] as const) {
    for (const failure of failures) {
      test(`maps engine-generated ${failure.code} on RPC ${method} to 500`, async () => {
        const response = await invoke(`rpc/${failure.name}`, failure.args, method)
        expect(response.status).toBe(500)
        if (method !== 'HEAD') {
          expect(await response.json()).toMatchObject({
            code: failure.code, message: failure.message, details: null,
          })
        }
      })
    }

    test(`keeps default RAISE EXCEPTION on RPC ${method} as 400`, async () => {
      const response = await invoke('rpc/business_failure', {}, method)
      expect(response.status).toBe(400)
      if (method !== 'HEAD') {
        expect(await response.json()).toEqual({
          code: 'P0001', message: 'Business rule rejected',
          details: 'Invalid operation', hint: 'Choose another operation',
        })
      }
    })
  }

  for (const role of ['anon', 'authenticated'] as const) {
    test(`does not classify a PL/pgSQL failure as an auth error for ${role}`, async () => {
      const response = await invoke('rpc/strict_rows', { row_count: 0 }, 'POST', role)
      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({ code: 'P0002' })
    })
  }

  for (const rowCount of [0, 2]) {
    test(`rolls back writes before STRICT failure with ${rowCount} rows`, async () => {
      const response = await invoke('rpc/write_then_strict', { row_count: rowCount })
      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({ code: rowCount === 0 ? 'P0002' : 'P0003' })
      expect((await db!.query('select * from public.plpgsql_error_log')).rows).toEqual([])
      const healthy = await invoke('rpc/strict_rows', { row_count: 1 })
      expect(healthy.status).toBe(200)
      expect(await healthy.json()).toBe(1)
    })
  }

  test('maps trigger PL/pgSQL failure and rolls back both writes', async () => {
    const response = await invoke('plpgsql_guard', { id: 1 })
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ code: 'P0002' })
    expect((await db!.query('select * from public.plpgsql_guard')).rows).toEqual([])
    expect((await db!.query('select * from public.plpgsql_error_log')).rows).toEqual([])
  })

  test('maps the P0 class while preserving the P0001 exception', () => {
    for (const code of ['P0000', 'P0002', 'P0003', 'P0004', 'P0ZZZ']) {
      expect(statusForSqlState(code)).toBe(500)
      expect(statusForSqlState(code, false)).toBe(500)
    }
    expect(statusForSqlState('P0001')).toBe(400)
    expect(statusForSqlState('P0001', false)).toBe(400)
  })

  test('preserves supplied PL/pgSQL diagnostic fields', async () => {
    const response = errorToResponse({
      code: 'P0002', message: 'Missing required row', detail: 'Expected one record', hint: 'Repair seed data',
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      code: 'P0002', message: 'Missing required row', details: 'Expected one record', hint: 'Repair seed data',
    })
  })

  test('preserves unrelated SQLSTATE and custom response mappings', async () => {
    for (const [code, status] of [
      ['08006', 503], ['53300', 503], ['53400', 500], ['57P01', 503],
      ['23505', 409], ['42P01', 404], ['25006', 405], ['40001', 409],
      ['40P01', 409], ['57014', 408], ['22003', 400], ['PT429', 429],
    ] as const) {
      expect(statusForSqlState(code)).toBe(status)
    }
    expect(statusForSqlState('42501', false)).toBe(401)
    expect(statusForSqlState('42501', true)).toBe(403)
    const custom = errorToResponse({
      code: 'PGRST', message: '{"code":"APP","message":"Custom"}',
      detail: '{"status":422,"headers":{"X-App":"custom"}}',
    })
    expect(custom.status).toBe(422)
    expect(custom.headers.get('x-app')).toBe('custom')
    expect(await custom.json()).toMatchObject({ code: 'APP' })
  })
})
