import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { hashPassword } from '../src/runtime/auth/password.js'
import { DEFAULT_AUTH_SETTINGS } from '../src/runtime/auth/settings.js'
import { Database } from '../src/runtime/db/database.js'
import { verifyJwt } from '../src/runtime/jwt.js'

describe('Password login account eligibility', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  let userId: string
  let passwordHash: string
  let replacementHash: string
  const email = 'password-eligibility@example.test'
  const password = 'correct-horse-battery-staple'
  const jwtSecret = 'password-eligibility-test-secret'.repeat(3)
  const previousSignIn = '2000-01-01T00:00:00.000Z'

  beforeAll(async () => {
    db = await Database.create()
    passwordHash = await hashPassword(password)
    replacementHash = await hashPassword('replacement-password')
  }, 60_000)

  beforeEach(async () => {
    await db!.exec(`
      delete from auth.refresh_tokens;
      delete from auth.audit_log_entries;
      delete from auth.users;
    `)
    const created = await db!.query<{ id: string }>(
      `insert into auth.users
         (email, encrypted_password, email_confirmed_at, last_sign_in_at)
       values ($1, $2, now(), $3) returning id`,
      [email, passwordHash, previousSignIn],
    )
    userId = created.rows[0].id
    auth = new AuthHandler(db!, {
      jwtSecret, apiUrl: 'http://lite.local', siteUrl: 'http://app.local',
      jwtExpiry: 3600, mailer: new InboxMailer(), rateLimiter: null,
      settings: { ...DEFAULT_AUTH_SETTINGS, autoconfirm: false },
    })
  })

  afterEach(async () => {
    await auth?.stop()
  })

  afterAll(async () => {
    await db?.close()
  })

  function login(loginEmail = email, loginPassword = password): Promise<Response> {
    const url = new URL('http://lite.local/auth/v1/token?grant_type=password')
    return auth!.handle(new Request(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: loginEmail, password: loginPassword }),
    }), { role: 'anon', claims: null }, url)
  }

  async function expectNoLogin(): Promise<void> {
    expect((await db!.query('select token from auth.refresh_tokens')).rows).toEqual([])
    expect((await db!.query(
      `select 1 from auth.audit_log_entries where payload->>'action' = 'login'`,
    )).rows).toEqual([])
    expect((await db!.query<{ unchanged: boolean }>(
      'select last_sign_in_at = $1::timestamptz as unchanged from auth.users where id = $2',
      [previousSignIn, userId],
    )).rows[0].unchanged).toBe(true)
  }

  async function expectRejected(response: Response, code: string): Promise<void> {
    expect(response.status).toBe(400)
    const body: Record<string, unknown> = await response.json()
    expect(body.error_code).toBe(code)
    expect(body.access_token).toBeUndefined()
    expect(body.refresh_token).toBeUndefined()
    await expectNoLogin()
  }

  // Inject a committed change after the real password check, before session issuance.
  async function loginAfterVerification(change: () => Promise<unknown>): Promise<Response> {
    const verify = Bun.password.verify.bind(Bun.password)
    const pending = spyOn(Bun.password, 'verify').mockImplementationOnce(async (candidate, hash, algorithm) => {
      const matched = await verify(candidate, hash, algorithm)
      await change()
      return matched
    })
    try {
      return await login()
    } finally {
      pending.mockRestore()
    }
  }

  async function expectSession(response: Response): Promise<void> {
    expect(response.status).toBe(200)
    const body: Record<string, unknown> = await response.json()
    if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
      throw new Error('Expected password login tokens')
    }
    expect(await verifyJwt(body.access_token, jwtSecret)).toMatchObject({
      sub: userId, email, role: 'authenticated',
    })
    expect((await db!.query<{ user_id: string }>(
      'select user_id from auth.refresh_tokens where token = $1',
      [body.refresh_token],
    )).rows).toEqual([{ user_id: userId }])
    expect((await db!.query(
      `select 1 from auth.audit_log_entries where payload->>'action' = 'login'`,
    )).rows).toHaveLength(1)
    expect((await db!.query<{ advanced: boolean }>(
      'select last_sign_in_at > $1::timestamptz as advanced from auth.users where id = $2',
      [previousSignIn, userId],
    )).rows[0].advanced).toBe(true)
  }

  const denied = [
    { name: 'active ban', update: "banned_until = now() + interval '1 hour'", code: 'user_banned' },
    { name: 'active ban with wrong password', update: "banned_until = now() + interval '1 hour'", code: 'user_banned', password: 'wrong-password' },
    { name: 'indefinite ban', update: "banned_until = 'infinity'", code: 'user_banned' },
    { name: 'soft-deleted account retaining credentials', update: 'deleted_at = now()', code: 'invalid_credentials' },
    { name: 'soft-deleted and banned account', update: "deleted_at = now(), banned_until = now() + interval '1 hour'", code: 'invalid_credentials' },
  ]

  for (const scenario of denied) {
    test(`rejects ${scenario.name} without issuing a session`, async () => {
      await db!.query(`update auth.users set ${scenario.update} where id = $1`, [userId])
      await expectRejected(await login(email, scenario.password ?? password), scenario.code)
    })
  }

  test('allows an active account with normalized email input', async () => {
    await expectSession(await login(` ${email.toUpperCase()} `))
  })

  test('allows login after a ban expires', async () => {
    await db!.query(`update auth.users set banned_until = now() - interval '1 hour' where id = $1`, [userId])
    await expectSession(await login())
  })

  test('allows login after a ban is cleared without restarting the handler', async () => {
    await db!.query(`update auth.users set banned_until = now() + interval '1 hour' where id = $1`, [userId])
    await expectRejected(await login(), 'user_banned')
    await db!.query('update auth.users set banned_until = null where id = $1', [userId])
    await expectSession(await login())
  })

  test('keeps unknown accounts indistinguishable from invalid credentials', async () => {
    await expectRejected(await login('unknown@example.test'), 'invalid_credentials')
  })

  test('rejects the wrong password for an active account', async () => {
    await expectRejected(await login(email, 'wrong-password'), 'invalid_credentials')
  })

  test('rejects accounts without a password', async () => {
    await db!.query('update auth.users set encrypted_password = null where id = $1', [userId])
    await expectRejected(await login(), 'invalid_credentials')
  })

  test('retains the email confirmation requirement', async () => {
    await db!.query('update auth.users set email_confirmed_at = null where id = $1', [userId])
    await expectRejected(await login(), 'email_not_confirmed')
  })

  for (const scenario of [
    { name: 'ban', update: "banned_until = now() + interval '1 hour'", code: 'user_banned' },
    { name: 'indefinite ban', update: "banned_until = 'infinity'", code: 'user_banned' },
    { name: 'soft deletion', update: 'deleted_at = now()', code: 'invalid_credentials' },
    { name: 'email change', update: "email = 'replacement@example.test'", code: 'invalid_credentials' },
    { name: 'password removal', update: 'encrypted_password = null', code: 'invalid_credentials' },
    { name: 'confirmation removal', update: 'email_confirmed_at = null', code: 'email_not_confirmed' },
  ]) {
    test(`given verified credentials, when ${scenario.name} commits, then issuance is rejected`, async () => {
      const response = await loginAfterVerification(() =>
        db!.query(`update auth.users set ${scenario.update} where id = $1`, [userId]),
      )
      await expectRejected(response, scenario.code)
    })
  }

  test('given a verified old password, when it is reset, then only the new password can sign in', async () => {
    const response = await loginAfterVerification(() =>
      db!.query('update auth.users set encrypted_password = $1 where id = $2', [replacementHash, userId]),
    )
    await expectRejected(response, 'invalid_credentials')
    await expectSession(await login(email, 'replacement-password'))
  })

  test('rejects hard deletion during password verification without a server error', async () => {
    const response = await loginAfterVerification(() => db!.query('delete from auth.users where id = $1', [userId]))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error_code: 'invalid_credentials' })
    expect((await db!.query('select token from auth.refresh_tokens')).rows).toEqual([])
    expect((await db!.query(
      `select 1 from auth.audit_log_entries where payload->>'action' = 'login'`,
    )).rows).toEqual([])
  })

  test('given changed authorization data, when login succeeds, then claims reflect the current row', async () => {
    const response = await loginAfterVerification(() =>
      db!.query(
        `update auth.users set role = 'authenticated', raw_app_meta_data = '{"access":"limited"}',
           raw_user_meta_data = '{"name":"updated"}' where id = $1`,
        [userId],
      ),
    )
    expect(response.status).toBe(200)
    const body = await response.json() as {
      access_token: string
      user: { app_metadata: Record<string, unknown>; user_metadata: Record<string, unknown>; last_sign_in_at: string }
    }
    expect(await verifyJwt(body.access_token, jwtSecret)).toMatchObject({
      sub: userId, role: 'authenticated', app_metadata: { access: 'limited' }, user_metadata: { name: 'updated' },
    })
    expect(body.user.app_metadata).toEqual({ access: 'limited' })
    expect(body.user.user_metadata).toEqual({ name: 'updated' })
    expect(Date.parse(body.user.last_sign_in_at)).toBeGreaterThan(Date.parse(previousSignIn))
  })

  test('given a session insert failure, when login fails, then sign-in time and success audit remain unchanged', async () => {
    await db!.exec(`
      create function public.reject_password_session() returns trigger language plpgsql as $$
      begin raise exception 'password session insert failed'; end $$;
      create trigger reject_password_session before insert on auth.refresh_tokens
      for each row execute function public.reject_password_session();
    `)
    try {
      const response = await login()
      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({ error_code: 'unexpected_failure' })
      await expectNoLogin()
    } finally {
      await db!.exec('drop trigger reject_password_session on auth.refresh_tokens; drop function public.reject_password_session();')
    }
    await expectSession(await login())
  })
})
