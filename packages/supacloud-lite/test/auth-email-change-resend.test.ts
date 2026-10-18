import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'
import { hashPassword } from '../src/runtime/auth/password.js'
import { DEFAULT_AUTH_SETTINGS } from '../src/runtime/auth/settings.js'

describe('Auth email change resend', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  let mailer: InboxMailer
  let accessToken: string

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec(`
      delete from auth.refresh_tokens;
      delete from auth.identities;
      delete from auth.one_time_tokens;
      delete from auth.flow_state;
      delete from auth.users;
    `)
    mailer = new InboxMailer()
    auth = new AuthHandler(db!, {
      jwtSecret: 'email-change-resend-secret'.repeat(2),
      apiUrl: 'http://lite.local',
      siteUrl: 'http://app.local',
      jwtExpiry: 3600,
      mailer,
      rateLimiter: null,
      settings: { ...DEFAULT_AUTH_SETTINGS, autoconfirm: false },
    })
    const user = (await db!.query<{ id: string }>(
      `insert into auth.users (email, email_confirmed_at)
       values ('before-resend@example.test', now())
       returning id`,
    )).rows[0]!
    const token = await signIn(user.id, 'before-resend@example.test')
    accessToken = token
  })
  afterEach(async () => { await auth?.stop() })
  afterAll(async () => { await db?.close() })

  test('resends only an existing pending email change', async () => {
    const requested = await updateEmail('after-resend@example.test')
    expect(requested.status).toBe(200)
    mailer.clear()

    const resent = await call('/resend', {
      email: 'after-resend@example.test',
      type: 'email_change',
    })
    expect(resent.status).toBe(200)
    expect(mailer.list()).toHaveLength(1)
    expect(mailer.list()[0]?.to).toBe('after-resend@example.test')
    expect(mailer.list()[0]?.subject).toBe('Confirm your email change')
  })

  test('does not reveal or create an unknown email change target', async () => {
    const resent = await call('/resend', {
      email: 'unknown-resend@example.test',
      type: 'email_change',
    })
    expect(resent.status).toBe(200)
    expect(await resent.json()).toEqual({})
    expect(mailer.list()).toHaveLength(0)
    expect((await db!.query('select count(*)::int as count from auth.users')).rows).toEqual([{ count: 1 }])
  })

  async function signIn(userId: string, email: string): Promise<string> {
    const encryptedPassword = await hashPassword('correct-horse-battery-staple')
    const password = await db!.query(
      `update auth.users set encrypted_password = $1
       where id = $2 returning id`,
      [encryptedPassword, userId],
    )
    expect(password.rows).toHaveLength(1)
    const response = await call('/token?grant_type=password', {
      email,
      password: 'correct-horse-battery-staple',
    })
    expect(response.status).toBe(200)
    return (await response.json()).access_token
  }

  function updateEmail(email: string): Promise<Response> {
    return call('/user?redirect_to=http%3A%2F%2Fapp.local%2Faccount', { email }, true, 'PUT')
  }

  function call(
    path: string,
    body: Record<string, unknown>,
    authenticated = false,
    method: 'POST' | 'PUT' = 'POST'
  ): Promise<Response> {
    const url = new URL(`http://lite.local/auth/v1${path}`)
    return auth!.handle(new Request(url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(authenticated ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
    }), { role: 'anon', claims: null }, url)
  }
})
