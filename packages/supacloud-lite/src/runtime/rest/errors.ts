/**
 * Turns thrown errors into PostgREST-shaped JSON error responses
 * ({ code, message, details, hint }) and maps Postgres SQLSTATEs to HTTP
 * statuses the way PostgREST does.
 */
import { ApiError } from '../types.js'
import { isRecord } from '../validation.js'
import { ParseError } from './parse.js'

/** HTTP status for a Postgres SQLSTATE, following PostgREST's mapping. */
export function statusForSqlState(code: string, authenticated = true): number {
  if (code.startsWith('PT')) {
    // Fetch Response accepts only final status codes from 200 through 599.
    return /^PT[2-5][0-9]{2}$/.test(code) ? Number(code.slice(2)) : 500
  }
  switch (code) {
    case '42501':
      return authenticated ? 403 : 401
    case '25006': // read_only_sql_transaction
      return 405
    case '23503':
    case '23505':
      return 409
    case '42P01': // undefined_table
    case '42883': // undefined_function
      return 404
    case '40P01': // deadlock
    case '40001': // serialization_failure
      return 409
    case '57014': // query_canceled
      return 408
    case '57P01': // admin_shutdown
      return 503
    case '53400': // configuration_limit_exceeded: PostgREST's 500 exception in class 53
      return 500
    case 'P0001': // default RAISE EXCEPTION remains a client error
      return 400
    default:
      // Connection exceptions and insufficient resources are server failures.
      if (code.startsWith('08') || code.startsWith('53')) return 503
      if (code.startsWith('P0')) return 500
      return 400
  }
}

/** Shape of a node-postgres / pg-mem error carrying a SQLSTATE. */
interface PgError {
  code?: string
  message: string
  detail?: string
  hint?: string
}

function invalidPgrstResponse(part: 'MESSAGE' | 'DETAIL'): Response {
  return jsonResponse(500, {
    code: 'PGRST121',
    message: 'Could not parse JSON in the "RAISE SQLSTATE \'PGRST\'" error',
    details: `Invalid JSON value or fields for ${part}`,
    hint: part === 'MESSAGE'
      ? "MESSAGE must contain string 'code' and 'message'; optional 'details' and 'hint' must be strings or null."
      : "DETAIL must contain integer 'status' (200-599), string-valued 'headers', and optional string 'status_text'.",
  })
}

function pgrstErrorToResponse(pg: PgError): Response {
  let part: 'MESSAGE' | 'DETAIL' = 'MESSAGE'
  try {
    const body: unknown = JSON.parse(pg.message)
    if (!isRecord(body) || typeof body.code !== 'string' || typeof body.message !== 'string'
      || (body.details != null && typeof body.details !== 'string')
      || (body.hint != null && typeof body.hint !== 'string')) {
      return invalidPgrstResponse(part)
    }
    part = 'DETAIL'
    const detail: unknown = JSON.parse(pg.detail ?? '')
    if (!isRecord(detail) || typeof detail.status !== 'number' || !Number.isInteger(detail.status)
      || detail.status < 200 || detail.status > 599 || !isRecord(detail.headers)
      || (detail.status_text != null && (typeof detail.status_text !== 'string'
        || !/^[\t\x20-\x7e\x80-\xff]*$/.test(detail.status_text)))) {
      return invalidPgrstResponse(part)
    }
    // Normalize casing and validate header names/values before constructing the response.
    const headers = new Headers()
    for (const [name, value] of Object.entries(detail.headers)) {
      if (typeof value !== 'string') return invalidPgrstResponse(part)
      headers.set(name, value)
    }
    return jsonResponse(detail.status, {
      code: body.code,
      message: body.message,
      details: body.details ?? null,
      hint: body.hint ?? null,
    }, Object.fromEntries(headers), typeof detail.status_text === 'string' ? detail.status_text : undefined)
  } catch {
    return invalidPgrstResponse(part)
  }
}

/**
 * Normalize thrown errors: ApiError/ParseError keep their status, PGRST
 * exceptions supply structured response metadata, and other 5-char SQLSTATEs
 * use {@link statusForSqlState}. Everything else becomes a 500.
 */
export function errorToResponse(e: unknown, authenticated = true): Response {
  if (e instanceof ApiError) {
    return jsonResponse(e.status, e.body)
  }
  if (e instanceof ParseError) {
    return jsonResponse(400, { code: 'PGRST100', message: e.message, details: null, hint: null })
  }
  const pg = e as PgError
  if (pg && typeof pg.code === 'string' && /^[0-9A-Z]{5}$/.test(pg.code)) {
    if (pg.code === 'PGRST') return pgrstErrorToResponse(pg)
    return jsonResponse(statusForSqlState(pg.code, authenticated), {
      code: pg.code,
      message: pg.message,
      details: pg.detail ?? null,
      hint: pg.hint ?? null,
    })
  }
  const message = e instanceof Error ? e.message : String(e)
  return jsonResponse(500, { code: 'PGRST500', message, details: null, hint: null })
}

/** JSON Response helper; null-body HTTP statuses never serialize a payload. */
export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
  statusText?: string
): Response {
  const bodyless = status === 204 || status === 205 || status === 304
  return new Response(bodyless ? null : JSON.stringify(body), {
    status,
    ...(statusText === undefined ? {} : { statusText }),
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}
