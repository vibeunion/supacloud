import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { hashPassword } from '../src/runtime/auth/password.js'
import { DEFAULT_AUTH_SETTINGS } from '../src/runtime/auth/settings.js'
import { Database } from '../src/runtime/db/database.js'
import { verifyJwt } from '../src/runtime/jwt.js'

describe('Refresh token account eligibility', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  let userId: string
  let passwordHash: string
  const email = 'refresh-eligibility@example.test'
  const password = 'correct-horse-battery-staple'
  const jwtSecret = 'refresh-eligibility-test-secret'.repeat(3)

  beforeAll(async () => {
    db = await Database.create()
    passwordHash = await hashPassword(password)
  }, 60_000)

  beforeEach(async () => {
    await db!.exec(`
      delete from auth.refresh_tokens;
      delete from auth.audit_log_entries;
      delete from auth.users;
    `)
    const created = await db!.query<{ id: string }>(
      `insert into auth.users (email, encrypted_password, email_confirmed_at)
       values ($1, $2, now()) returning id`,
      [email, passwordHash],
    )
    userId = created.rows[0].id
    auth = new AuthHandler(db!, {
      jwtSecret, apiUrl: 'http://lite.local', siteUrl: 'http://app.local',
      jwtExpiry: 3600, mailer: new InboxMailer(), rateLimiter: null,
      sessionTimeboxSeconds: 3600, sessionInactivitySeconds: 1800,
      settings: { ...DEFAULT_AUTH_SETTINGS, autoconfirm: false },
    })
  })

  afterEach(async () => {
    await auth?.stop()
  })

  afterAll(async () => {
    await db?.close()
  })

  async function passwordLogin(): Promise<{ accessToken: string; refreshToken: string }> {
    const url = new URL('http://lite.local/auth/v1/token?grant_type=password')
    const response = await auth!.handle(new Request(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }), { role: 'anon', claims: null }, url)
    expect(response.status).toBe(200)
    const body: Record<string, unknown> = await response.json()
    if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
      throw new Error('Expected password login tokens')
    }
    return { accessToken: body.access_token, refreshToken: body.refresh_token }
  }

  async function refresh(refreshToken: string): Promise<Response> {
    const url = new URL('http://lite.local/auth/v1/token?grant_type=refresh_token')
    return auth!.handle(new Request(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }), { role: 'anon', claims: null }, url)
  }

  async function refreshBody(response: Response): Promise<Record<string, unknown>> {
    return await response.json() as Record<string, unknown>
  }

  async function expectRejected(response: Response, code: string, refreshToken: string): Promise<void> {
    expect(response.status).toBe(400)
    const body = await refreshBody(response)
    expect(body.error_code).toBe(code)
    expect(body.access_token).toBeUndefined()
    expect(body.refresh_token).toBeUndefined()
    expect((await db!.query<{ revoked: boolean }>(
      'select revoked from auth.refresh_tokens where token = $1',
      [refreshToken],
    )).rows).toEqual([{ revoked: false }])
    expect((await db!.query(
      `select 1 from auth.refresh_tokens where token <> $1`,
      [refreshToken],
    )).rows).toEqual([])
  }

  test('rotates a refresh token for an eligible account', async () => {
    const current = await passwordLogin()
    const response = await refresh(current.refreshToken)
    expect(response.status).toBe(200)
    const body = await refreshBody(response)
    expect(body.refresh_token).toEqual(expect.any(String))
    expect(body.access_token).toEqual(expect.any(String))
    expect(await verifyJwt(String(body.access_token), jwtSecret)).toMatchObject({
      sub: userId, email, role: 'authenticated',
      session_id: (await verifyJwt(current.accessToken, jwtSecret))?.session_id,
    })
    expect((await db!.query<{ revoked: boolean }>(
      'select revoked from auth.refresh_tokens where token = $1',
      [current.refreshToken],
    )).rows).toEqual([{ revoked: true }])
    expect((await db!.query(
      'select parent from auth.refresh_tokens where token = $1',
      [body.refresh_token],
    )).rows).toEqual([{ parent: current.refreshToken }])
  })

  test('rejects refresh for an active ban without consuming the token', async () => {
    const current = await passwordLogin()
    await db!.query(`update auth.users set banned_until = now() + interval '1 hour' where id = $1`, [userId])
    await expectRejected(await refresh(current.refreshToken), 'user_banned', current.refreshToken)
  })

  test('rejects refresh for an indefinite ban without consuming the token', async () => {
    const current = await passwordLogin()
    await db!.query(`update auth.users set banned_until = 'infinity' where id = $1`, [userId])
    await expectRejected(await refresh(current.refreshToken), 'user_banned', current.refreshToken)
  })

  test('rejects refresh for a soft-deleted account without consuming the token', async () => {
    const current = await passwordLogin()
    await db!.query('update auth.users set deleted_at = now() where id = $1', [userId])
    await expectRejected(await refresh(current.refreshToken), 'refresh_token_not_found', current.refreshToken)
  })

  test('allows the same token after a ban is cleared', async () => {
    const current = await passwordLogin()
    await db!.query(`update auth.users set banned_until = now() + interval '1 hour' where id = $1`, [userId])
    await expectRejected(await refresh(current.refreshToken), 'user_banned', current.refreshToken)
    await db!.query('update auth.users set banned_until = null where id = $1', [userId])
    const response = await refresh(current.refreshToken)
    expect(response.status).toBe(200)
    expect((await refreshBody(response)).user).toMatchObject({ id: userId, email })
  })

  test('allows an expired ban to refresh', async () => {
    const current = await passwordLogin()
    await db!.query(`update auth.users set banned_until = now() - interval '1 hour' where id = $1`, [userId])
    expect((await refresh(current.refreshToken)).status).toBe(200)
  })

  test('keeps concurrent refresh single-use behavior after eligibility checks', async () => {
    const current = await passwordLogin()
    const responses = await Promise.all([refresh(current.refreshToken), refresh(current.refreshToken)])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400])
    const rejected = responses.find((response) => response.status === 400)!
    expect(await refreshBody(rejected)).toMatchObject({ error_code: 'refresh_token_not_found' })
    expect((await db!.query(
      'select revoked from auth.refresh_tokens where parent = $1',
      [current.refreshToken],
    )).rows).toEqual([{ revoked: false }])
  })

  test('does not mutate tokens on repeated banned refresh attempts', async () => {
    const current = await passwordLogin()
    await db!.query(`update auth.users set banned_until = now() + interval '1 hour' where id = $1`, [userId])
    const before = await db!.query('select * from auth.refresh_tokens')
    await expectRejected(await refresh(current.refreshToken), 'user_banned', current.refreshToken)
    await expectRejected(await refresh(current.refreshToken), 'user_banned', current.refreshToken)
    expect((await db!.query('select * from auth.refresh_tokens')).rows).toEqual(before.rows)
  })

  test('rejects an unknown token without consuming a valid token', async () => {
    const current = await passwordLogin()
    await expectRejected(await refresh('unknown-refresh-token'), 'refresh_token_not_found', current.refreshToken)
  })

  test('keeps revoked tokens invalid even when the account is banned', async () => {
    const current = await passwordLogin()
    await db!.query('update auth.refresh_tokens set revoked = true where token = $1', [current.refreshToken])
    await db!.query(`update auth.users set banned_until = now() + interval '1 hour' where id = $1`, [userId])
    const before = await db!.query('select * from auth.refresh_tokens')
    const response = await refresh(current.refreshToken)
    expect(response.status).toBe(400)
    expect(await refreshBody(response)).toMatchObject({ error_code: 'refresh_token_not_found' })
    expect((await db!.query('select * from auth.refresh_tokens')).rows).toEqual(before.rows)
  })

  test('retains the inactivity deadline for eligible accounts', async () => {
    const current = await passwordLogin()
    await db!.query(
      `update auth.refresh_tokens set created_at = now() - interval '31 minutes' where token = $1`,
      [current.refreshToken],
    )
    const response = await refresh(current.refreshToken)
    expect(response.status).toBe(400)
    expect(await refreshBody(response)).toMatchObject({ error_code: 'session_expired' })
    expect((await db!.query('select token from auth.refresh_tokens where parent = $1', [current.refreshToken])).rows).toEqual([])
  })

  test('does not reset the absolute session deadline during rotation', async () => {
    const current = await passwordLogin()
    const first = await refresh(current.refreshToken)
    expect(first.status).toBe(200)
    const body = await refreshBody(first)
    if (typeof body.refresh_token !== 'string') throw new Error('Expected rotated refresh token')
    await db!.query(
      `update auth.refresh_tokens set created_at = now() - interval '2 hours' where token = $1`,
      [current.refreshToken],
    )
    const response = await refresh(body.refresh_token)
    expect(response.status).toBe(400)
    expect(await refreshBody(response)).toMatchObject({ error_code: 'session_expired' })
    expect((await db!.query('select token from auth.refresh_tokens where parent = $1', [body.refresh_token])).rows).toEqual([])
  })
})
