import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { errorToResponse, statusForSqlState } from '../src/runtime/rest/errors.js'
import { Database } from '../src/runtime/db/database.js'
import { RestHandler } from '../src/runtime/rest/handler.js'
import { ApiError } from '../src/runtime/types.js'

describe('REST custom PT SQLSTATE responses', () => {
  let db: Database | undefined
  let rest: RestHandler

  beforeAll(async () => {
    db = await Database.create()
    await db.exec(`
      create table public.custom_status_log (id integer);
      create function public.raise_http(http_code text default 'PT429') returns integer
        language plpgsql stable as $$ begin
          raise exception using errcode = http_code, message = 'Request rejected',
            detail = 'Custom application failure', hint = 'Try again later';
        end $$;
      create function public.write_then_raise(http_code text) returns integer
        language plpgsql volatile as $$ begin
          insert into public.custom_status_log values (1);
          raise exception using errcode = http_code, message = 'Write rejected';
        end $$;
      create table public.guarded_items (id integer);
      create function public.reject_guarded_insert() returns trigger
        language plpgsql as $$ begin
          insert into public.custom_status_log values (2);
          raise exception using errcode = 'PT409', message = 'Conflict',
            detail = 'Row rejected', hint = 'Change the request';
        end $$;
      create trigger reject_insert after insert on public.guarded_items
        for each row execute function public.reject_guarded_insert();
      create function public.healthy_rpc() returns integer language sql stable as $$ select 7 $$;
    `)
    rest = new RestHandler(db)
  }, 60_000)

  beforeEach(async () => {
    await db!.query('delete from public.custom_status_log')
    await db!.query('delete from public.guarded_items')
  })

  afterAll(async () => {
    await db?.close()
  })

  function invoke(
    path: string,
    method: 'GET' | 'HEAD' | 'POST' = 'POST',
    body: Record<string, string | number> = {},
    role: 'anon' | 'authenticated' | 'service_role' = 'service_role',
  ) {
    const url = new URL(`http://lite.local/rest/v1/${path}`)
    if (method !== 'POST') {
      for (const [key, value] of Object.entries(body)) url.searchParams.set(key, String(value))
    }
    return rest.handle(new Request(url, {
      method,
      headers: { 'content-type': 'application/json', prefer: 'return=representation' },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    }), { role, claims: { role } }, url)
  }

  for (const method of ['GET', 'HEAD', 'POST'] as const) {
    for (const status of [402, 503]) {
      test(`preserves custom status ${status} on RPC ${method}`, async () => {
        const response = await invoke('rpc/raise_http', method, { http_code: `PT${status}` })
        expect(response.status).toBe(status)
        if (method !== 'HEAD') {
          expect(await response.json()).toEqual({
            code: `PT${status}`, message: 'Request rejected',
            details: 'Custom application failure', hint: 'Try again later',
          })
        }
      })
    }
  }

  for (const role of ['anon', 'authenticated', 'service_role'] as const) {
    test(`does not reinterpret an explicit PT403 for ${role}`, async () => {
      const response = await invoke('rpc/raise_http', 'POST', { http_code: 'PT403' }, role)
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: 'PT403' })
    })
  }

  for (const status of [409, 429, 503]) {
    test(`rolls back RPC writes on PT${status} and keeps later requests healthy`, async () => {
      const response = await invoke('rpc/write_then_raise', 'POST', { http_code: `PT${status}` })
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual({
        code: `PT${status}`, message: 'Write rejected', details: null, hint: null,
      })
      expect((await db!.query('select * from public.custom_status_log')).rows).toEqual([])
      const healthy = await invoke('rpc/healthy_rpc')
      expect(healthy.status).toBe(200)
      expect(await healthy.json()).toBe(7)
    })
  }

  test('maps custom table trigger failures without committing either write', async () => {
    const response = await invoke('guarded_items', 'POST', { id: 1 })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      code: 'PT409', message: 'Conflict', details: 'Row rejected', hint: 'Change the request',
    })
    expect((await db!.query('select * from public.guarded_items')).rows).toEqual([])
    expect((await db!.query('select * from public.custom_status_log')).rows).toEqual([])
  })

  test('accepts the full Fetch-supported final response range, including nonstandard codes', () => {
    for (const status of [200, 201, 202, 299, 300, 399, 402, 419, 429, 499, 503, 599]) {
      const error = { code: `PT${status}`, message: 'Custom status' }
      expect(statusForSqlState(error.code)).toBe(status)
      expect(errorToResponse(error).status).toBe(status)
    }
  })

  for (const status of [204, 205, 304]) {
    test(`constructs a bodyless PT${status} response without throwing`, async () => {
      const response = await invoke('rpc/raise_http', 'POST', { http_code: `PT${status}` })
      expect(response.status).toBe(status)
      expect(response.body).toBeNull()
      expect(await response.text()).toBe('')
    })
  }

  test('returns 500 for malformed or unsupported PT status values', async () => {
    for (const code of ['PTABC', 'PT4A0', 'PT000', 'PT199', 'PT600', 'PT999']) {
      const response = await invoke('rpc/raise_http', 'POST', { http_code: code })
      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({ code, message: 'Request rejected' })
    }
  })

  test('preserves built-in SQLSTATE, explicit ApiError and generic error behavior', async () => {
    expect(errorToResponse({ code: '42501', message: 'Denied' }, false).status).toBe(401)
    expect(errorToResponse({ code: '42501', message: 'Denied' }, true).status).toBe(403)
    expect(errorToResponse({ code: '23505', message: 'Duplicate' }).status).toBe(409)
    expect(errorToResponse({ code: '25006', message: 'Read only' }).status).toBe(405)
    expect(errorToResponse({ code: 'P0001', message: 'Failure' }).status).toBe(400)
    const explicit = new ApiError(409, { code: 'PT503', message: 'Explicit', details: null, hint: null })
    expect(errorToResponse(explicit).status).toBe(409)
    const generic = errorToResponse(new Error('Unexpected'))
    expect(generic.status).toBe(500)
    expect(await generic.json()).toMatchObject({ code: 'PGRST500' })
  })
})
