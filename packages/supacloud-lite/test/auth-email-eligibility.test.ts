import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'
import { verifyJwt } from '../src/runtime/jwt.js'

describe('Email token account eligibility and atomic sessions', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  let userId: string
  const email = 'email-eligibility@example.test'
  const code = '123456'
  const secret = 'email-eligibility-secret'.repeat(3)
  const kinds = ['otp', 'magiclink', 'recovery'] as const
  type Kind = typeof kinds[number]

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.users;')
    userId = (await db!.query<{ id: string }>(
      `insert into auth.users (email, last_sign_in_at) values ($1, '2000-01-01') returning id`,
      [email],
    )).rows[0].id
    auth = new AuthHandler(db!, {
      jwtSecret: secret, apiUrl: 'http://lite.local', siteUrl: 'http://app.local/callback',
      jwtExpiry: 3600, mailer: new InboxMailer(), rateLimiter: null,
    })
  })
  afterEach(async () => { await auth?.stop() })
  afterAll(async () => { await db?.close() })

  async function issue(kind: Kind) {
    await db!.query(
      `insert into auth.one_time_tokens (user_id, email, token_type, token, expires_at)
       values ($1, $2, $3, $4, now() + interval '1 hour')`,
      [userId, email, kind, code],
    )
  }

  function verify(kind: Kind, method: 'GET' | 'POST', token = code) {
    const url = new URL('http://lite.local/auth/v1/verify')
    if (method === 'GET') {
      url.search = new URLSearchParams({ token, type: kind }).toString()
    }
    return auth!.handle(new Request(url, {
      method,
      ...(method === 'POST' ? {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, email, type: kind === 'otp' ? 'email' : kind }),
      } : {}),
    }), { role: 'anon', claims: null }, url)
  }

  async function snapshot() {
    return {
      users: (await db!.query(
        'select email_confirmed_at::text, last_sign_in_at::text from auth.users',
      )).rows,
      tokens: (await db!.query(
        'select id, token, attempts, expires_at::text from auth.one_time_tokens order by id',
      )).rows,
      sessions: (await db!.query('select token from auth.refresh_tokens')).rows,
    }
  }

  async function expectRejected(response: Response, method: 'GET' | 'POST') {
    if (method === 'POST') {
      expect(response.status).toBe(403)
      const body: Record<string, unknown> = await response.json()
      expect(body.error_code).toBe('otp_expired')
      expect(body.access_token).toBeUndefined()
    } else {
      expect(response.status).toBe(303)
      const fragment = new URLSearchParams(new URL(response.headers.get('location')!).hash.slice(1))
      expect(fragment.get('error_code')).toBe('otp_expired')
      expect(fragment.has('access_token')).toBe(false)
    }
  }

  async function expectSession(response: Response, method: 'GET' | 'POST') {
    let accessToken: unknown
    if (method === 'POST') {
      expect(response.status).toBe(200)
      const body: Record<string, unknown> = await response.json()
      accessToken = body.access_token
    } else {
      expect(response.status).toBe(303)
      accessToken = new URLSearchParams(new URL(response.headers.get('location')!).hash.slice(1)).get('access_token')
    }
    if (typeof accessToken !== 'string') throw new Error('Expected email session')
    expect(await verifyJwt(accessToken, secret)).toMatchObject({ sub: userId, email })
    expect((await db!.query('select user_id from auth.refresh_tokens')).rows).toEqual([{ user_id: userId }])
    expect((await db!.query('select token from auth.one_time_tokens')).rows).toEqual([])
  }

  for (const method of ['GET', 'POST'] as const) {
    for (const kind of kinds) {
      for (const state of [
        { name: 'banned', sql: "banned_until = now() + interval '1 hour'" },
        { name: 'indefinitely banned', sql: "banned_until = 'infinity'" },
        { name: 'soft-deleted', sql: 'deleted_at = now()' },
      ]) {
        test(`rejects ${state.name} ${kind} via ${method} without consuming tokens or confirming the user`, async () => {
          await issue(kind)
          await db!.query(`update auth.users set ${state.sql} where id = $1`, [userId])
          const before = await snapshot()
          await expectRejected(await verify(kind, method), method)
          expect(await snapshot()).toEqual(before)
        })
      }
      test(`allows eligible ${kind} via ${method} and rejects replay`, async () => {
        await issue(kind)
        await expectSession(await verify(kind, method), method)
        await expectRejected(await verify(kind, method), method)
        expect((await db!.query('select token from auth.refresh_tokens')).rows).toHaveLength(1)
      })
    }

    test(`allows the same email token after clearing a ban via ${method}`, async () => {
      await issue('magiclink')
      await db!.query(`update auth.users set banned_until = now() + interval '1 hour' where id = $1`, [userId])
      await expectRejected(await verify('magiclink', method), method)
      await db!.query('update auth.users set banned_until = null where id = $1', [userId])
      await expectSession(await verify('magiclink', method), method)
    })

    test(`allows an expired ban via ${method}`, async () => {
      await issue('otp')
      await db!.query(`update auth.users set banned_until = now() - interval '1 hour' where id = $1`, [userId])
      await expectSession(await verify('otp', method), method)
    })

    test(`rolls back email token consumption and confirmation when session persistence fails via ${method}`, async () => {
      await issue('recovery')
      const before = await snapshot()
      await db!.exec(`
        create function public.reject_email_session() returns trigger language plpgsql as $$
          begin raise exception 'Simulated session insert failure'; end $$;
        create trigger reject_email_session before insert on auth.refresh_tokens
          for each row execute function public.reject_email_session();
      `)
      try {
        expect((await verify('recovery', method)).status).toBe(500)
        expect(await snapshot()).toEqual(before)
      } finally {
        await db!.exec('drop trigger reject_email_session on auth.refresh_tokens; drop function public.reject_email_session();')
      }
      await expectSession(await verify('recovery', method), method)
    })
  }

  test('does not redeem recovery tokens as ordinary email OTPs', async () => {
    await issue('recovery')
    await expectRejected(await verify('otp', 'POST'), 'POST')
    await expectSession(await verify('recovery', 'POST'), 'POST')
  })

  test('retains expiry and wrong-code attempt limits', async () => {
    await issue('otp')
    await expectRejected(await verify('otp', 'POST', '000000'), 'POST')
    expect((await db!.query('select attempts from auth.one_time_tokens')).rows).toEqual([{ attempts: 1 }])
    await db!.query(`update auth.one_time_tokens set expires_at = now() - interval '1 minute'`)
    await expectRejected(await verify('otp', 'POST'), 'POST')
    expect((await db!.query('select token from auth.refresh_tokens')).rows).toEqual([])
  })
})
