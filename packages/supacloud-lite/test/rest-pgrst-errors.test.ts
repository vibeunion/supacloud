import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from '../src/runtime/db/database.js'
import { errorToResponse } from '../src/runtime/rest/errors.js'
import { RestHandler } from '../src/runtime/rest/handler.js'
import { ApiError } from '../src/runtime/types.js'

const message = {
  code: 'QUOTA_EXCEEDED', message: 'Request rejected', details: 'Quota exhausted', hint: 'Try later',
}
const detail = { status: 429, headers: { 'Retry-After': '60', 'X-Request-Policy': 'quota' } }

function raised(body: unknown = message, response: unknown = detail) {
  return errorToResponse({
    code: 'PGRST', message: JSON.stringify(body), detail: JSON.stringify(response),
  })
}

describe('REST structured PGRST exceptions', () => {
  let db: Database | undefined
  let rest: RestHandler

  beforeAll(async () => {
    db = await Database.create()
    await db.exec(`
      create table public.structured_error_log (id integer);
      create function public.raise_response(body_json text, response_json text) returns integer
        language plpgsql stable as $$ begin
          raise exception using errcode = 'PGRST', message = body_json, detail = response_json;
        end $$;
      create function public.write_then_respond(body_json text, response_json text) returns integer
        language plpgsql volatile as $$ begin
          insert into public.structured_error_log values (1);
          raise exception using errcode = 'PGRST', message = body_json, detail = response_json;
        end $$;
      create table public.structured_guard (id integer);
      create function public.guard_response() returns trigger language plpgsql as $$ begin
        insert into public.structured_error_log values (2);
        raise sqlstate 'PGRST'
          using message = '{"code":"ROW_CONFLICT","message":"Conflict"}',
                detail = '{"status":409,"headers":{"X-Conflict":"row"}}';
      end $$;
      create trigger structured_guard_insert after insert on public.structured_guard
        for each row execute function public.guard_response();
    `)
    rest = new RestHandler(db)
  }, 60_000)

  beforeEach(async () => {
    await db!.query('delete from public.structured_error_log')
    await db!.query('delete from public.structured_guard')
  })

  afterAll(async () => {
    await db?.close()
  })

  function invoke(
    path: string,
    args: Record<string, string | number>,
    method: 'GET' | 'HEAD' | 'POST' = 'POST',
  ) {
    const url = new URL(`http://lite.local/rest/v1/${path}`)
    if (method !== 'POST') {
      for (const [key, value] of Object.entries(args)) url.searchParams.set(key, String(value))
    }
    return rest.handle(new Request(url, {
      method, headers: { 'content-type': 'application/json', prefer: 'return=representation' },
      ...(method === 'POST' ? { body: JSON.stringify(args) } : {}),
    }), { role: 'service_role', claims: { role: 'service_role' } }, url)
  }

  for (const method of ['GET', 'HEAD', 'POST'] as const) {
    test(`preserves the declared status, headers and JSON fields on ${method}`, async () => {
      const response = await invoke('rpc/raise_response', {
        body_json: JSON.stringify(message), response_json: JSON.stringify(detail),
      }, method)
      expect(response.status).toBe(429)
      expect(response.headers.get('retry-after')).toBe('60')
      expect(response.headers.get('x-request-policy')).toBe('quota')
      if (method !== 'HEAD') expect(await response.json()).toEqual(message)
    })
  }

  test('defaults optional body fields to null and ignores the outer PostgreSQL hint', async () => {
    const response = errorToResponse({
      code: 'PGRST', message: '{"code":"REJECTED","message":"No"}',
      detail: '{"status":403,"headers":{}}', hint: 'Outer hint',
    }, false)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ code: 'REJECTED', message: 'No', details: null, hint: null })
  })

  test('accepts explicit null optionals and ignores unrelated JSON keys', async () => {
    const response = raised(
      { code: 'APP', message: 'Custom', details: null, hint: null, ignored: true },
      { status: 422, headers: {}, status_text: null, ignored: true },
    )
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ code: 'APP', message: 'Custom', details: null, hint: null })
  })

  test('supports custom status text and case-insensitive content type replacement', async () => {
    const response = raised(message, {
      status: 419, status_text: 'Page Expired', headers: { 'Content-Type': 'application/problem+json' },
    })
    expect(response.status).toBe(419)
    expect(response.statusText).toBe('Page Expired')
    expect(response.headers.get('content-type')).toBe('application/problem+json')
    expect(await response.json()).toEqual(message)
  })

  test('rolls back RPC writes and leaves the connection usable', async () => {
    const response = await invoke('rpc/write_then_respond', {
      body_json: JSON.stringify(message), response_json: JSON.stringify(detail),
    })
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('60')
    expect((await db!.query('select * from public.structured_error_log')).rows).toEqual([])
    expect((await db!.query<{ value: number }>('select 7 as value')).rows).toEqual([{ value: 7 }])
  })

  test('preserves trigger response headers while rolling back both writes', async () => {
    const response = await invoke('structured_guard', { id: 1 })
    expect(response.status).toBe(409)
    expect(response.headers.get('x-conflict')).toBe('row')
    expect(await response.json()).toEqual({
      code: 'ROW_CONFLICT', message: 'Conflict', details: null, hint: null,
    })
    expect((await db!.query('select * from public.structured_guard')).rows).toEqual([])
    expect((await db!.query('select * from public.structured_error_log')).rows).toEqual([])
  })

  for (const status of [204, 205, 304]) {
    test(`keeps status ${status} bodyless without losing custom headers or rollback`, async () => {
      const response = await invoke('rpc/write_then_respond', {
        body_json: JSON.stringify(message),
        response_json: JSON.stringify({ status, headers: { 'X-Result': 'custom' } }),
      })
      expect(response.status).toBe(status)
      expect(response.body).toBeNull()
      expect(response.headers.get('x-result')).toBe('custom')
      expect((await db!.query('select * from public.structured_error_log')).rows).toEqual([])
    })
  }

  const invalidMessages: unknown[] = [
    null, [], 42, {}, { code: 1, message: 'No' }, { code: 'APP' },
    { code: 'APP', message: 'No', details: {} }, { code: 'APP', message: 'No', hint: 1 },
  ]
  for (const body of invalidMessages) {
    test(`rejects invalid MESSAGE shape ${JSON.stringify(body)}`, async () => {
      const response = raised(body)
      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({
        code: 'PGRST121', hint: expect.stringContaining('MESSAGE'),
      })
      expect(response.headers.get('retry-after')).toBeNull()
    })
  }

  const invalidDetails: unknown[] = [
    null, [], {}, { status: 429 }, { headers: {} },
    { status: '429', headers: {} }, { status: 429.5, headers: {} },
    { status: 199, headers: {} }, { status: 600, headers: {} },
    { status: 429, headers: [] }, { status: 429, headers: { 'Retry-After': 60 } },
    { status: 429, headers: {}, status_text: 1 },
    { status: 429, headers: {}, status_text: 'bad\r\ntext' },
    { status: 429, headers: {}, status_text: 'bad\u0000text' },
    { status: 429, headers: {}, status_text: 'bad\u007ftext' },
    { status: 429, headers: {}, status_text: '\u0100' },
    { status: 429, headers: { 'bad name': 'value' } },
    { status: 429, headers: { 'X-Test': 'bad\r\nvalue' } },
  ]
  for (const responseDetail of invalidDetails) {
    test(`rejects invalid DETAIL shape ${JSON.stringify(responseDetail)}`, async () => {
      const response = raised(message, responseDetail)
      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({
        code: 'PGRST121', hint: expect.stringContaining('DETAIL'),
      })
    })
  }

  test('handles malformed JSON and missing DETAIL without throwing', async () => {
    for (const error of [
      { code: 'PGRST', message: '{invalid', detail: JSON.stringify(detail) },
      { code: 'PGRST', message: JSON.stringify(message), detail: '{invalid' },
      { code: 'PGRST', message: JSON.stringify(message) },
    ]) {
      const response = errorToResponse(error)
      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({ code: 'PGRST121' })
    }
  })

  test('invalid response metadata still rolls back a database mutation', async () => {
    const response = await invoke('rpc/write_then_respond', {
      body_json: JSON.stringify(message), response_json: '{invalid',
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ code: 'PGRST121' })
    expect((await db!.query('select * from public.structured_error_log')).rows).toEqual([])
  })

  test('keeps PT, ordinary SQLSTATE and explicit ApiError handling unchanged', () => {
    expect(errorToResponse({ code: 'PT429', message: 'Limited' }).status).toBe(429)
    expect(errorToResponse({ code: '42501', message: 'Denied' }, false).status).toBe(401)
    expect(errorToResponse({ code: '42501', message: 'Denied' }, true).status).toBe(403)
    expect(errorToResponse(new ApiError(409, {
      code: 'PGRST', message: 'Explicit', details: null, hint: null,
    })).status).toBe(409)
  })
})
