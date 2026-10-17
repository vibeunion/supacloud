import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from '../src/runtime/db/database.js'
import { errorToResponse, statusForSqlState } from '../src/runtime/rest/errors.js'
import { RestHandler } from '../src/runtime/rest/handler.js'

describe('REST database service failure status mapping', () => {
  let db: Database | undefined
  let rest: RestHandler

  beforeAll(async () => {
    db = await Database.create()
    await db.exec(`
      create table public.service_error_log (id integer);
      create function public.service_failure(error_code text) returns integer
        language plpgsql stable as $$ begin
          raise exception using errcode = error_code, message = 'Database unavailable',
            detail = 'Simulated database failure', hint = 'Inspect database service';
        end $$;
      create function public.write_then_fail(error_code text) returns integer
        language plpgsql volatile as $$ begin
          insert into public.service_error_log values (1);
          raise exception using errcode = error_code, message = 'Database unavailable';
        end $$;
      create table public.service_guard (id integer);
      create function public.reject_service_write() returns trigger language plpgsql as $$ begin
        insert into public.service_error_log values (2);
        raise sqlstate '53200' using message = 'Simulated resource failure';
      end $$;
      create trigger service_guard_insert after insert on public.service_guard
        for each row execute function public.reject_service_write();
      create function public.service_healthy() returns integer language sql stable as $$ select 7 $$;
    `)
    rest = new RestHandler(db)
  }, 60_000)

  beforeEach(async () => {
    await db!.query('delete from public.service_error_log')
    await db!.query('delete from public.service_guard')
  })

  afterAll(async () => {
    await db?.close()
  })

  function invoke(
    path: string,
    args: Record<string, string | number>,
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

  for (const method of ['GET', 'HEAD', 'POST'] as const) {
    for (const [code, status] of [['08006', 503], ['53300', 503], ['57P01', 503], ['53400', 500]] as const) {
      test(`maps ${code} on RPC ${method} to ${status}`, async () => {
        const response = await invoke('rpc/service_failure', { error_code: code }, method)
        expect(response.status).toBe(status)
        if (method !== 'HEAD') {
          expect(await response.json()).toEqual({
            code, message: 'Database unavailable',
            details: 'Simulated database failure', hint: 'Inspect database service',
          })
        }
      })
    }
  }

  test('maps connection and resource SQLSTATE classes, not just individual examples', () => {
    for (const code of ['08000', '08001', '08003', '08004', '08006', '08007', '08P01',
      '53000', '53100', '53200', '53300', '53ZZZ']) {
      expect(statusForSqlState(code)).toBe(503)
      expect(statusForSqlState(code, false)).toBe(503)
    }
    expect(statusForSqlState('53400')).toBe(500)
    expect(statusForSqlState('57P01')).toBe(503)
  })

  for (const role of ['anon', 'authenticated'] as const) {
    test(`does not misclassify service failure as an auth error for ${role}`, async () => {
      const response = await invoke('rpc/service_failure', { error_code: '08006' }, 'POST', role)
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ code: '08006' })
    })
  }

  for (const code of ['08006', '53100', '57P01']) {
    test(`preserves rollback after ${code} without poisoning later requests`, async () => {
      const response = await invoke('rpc/write_then_fail', { error_code: code })
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({
        code, message: 'Database unavailable', details: null, hint: null,
      })
      expect((await db!.query('select * from public.service_error_log')).rows).toEqual([])
      const healthy = await invoke('rpc/service_healthy', {})
      expect(healthy.status).toBe(200)
      expect(await healthy.json()).toBe(7)
    })
  }

  test('maps a resource failure from a table trigger and rolls back both writes', async () => {
    const response = await invoke('service_guard', { id: 1 })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: '53200' })
    expect((await db!.query('select * from public.service_guard')).rows).toEqual([])
    expect((await db!.query('select * from public.service_error_log')).rows).toEqual([])
  })

  test('preserves existing unrelated SQLSTATE and custom response mappings', async () => {
    for (const [code, status] of [
      ['23505', 409], ['42P01', 404], ['25006', 405], ['40001', 409],
      ['40P01', 409], ['57014', 408], ['P0001', 400], ['22003', 400], ['PT429', 429],
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
