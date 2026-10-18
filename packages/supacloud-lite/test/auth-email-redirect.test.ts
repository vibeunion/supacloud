import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { DEFAULT_AUTH_SETTINGS } from '../src/runtime/auth/settings.js'
import { Database } from '../src/runtime/db/database.js'

describe('Auth email redirect links', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  let mailer: InboxMailer

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.one_time_tokens; delete from auth.users;')
    mailer = new InboxMailer()
    auth = new AuthHandler(db!, {
      jwtSecret: 'email-redirect-secret'.repeat(2),
      apiUrl: 'http://lite.local',
      siteUrl: 'http://app.local/default',
      jwtExpiry: 3600,
      mailer,
      rateLimiter: null,
      settings: { ...DEFAULT_AUTH_SETTINGS, autoconfirm: false },
    })
  })
  afterEach(async () => { await auth?.stop() })
  afterAll(async () => { await db?.close() })

  async function request(path: string, body: Record<string, unknown>, redirectTo: string): Promise<Response> {
    const url = new URL(`http://lite.local/auth/v1/${path}`)
    url.searchParams.set('redirect_to', redirectTo)
    return auth!.handle(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), { role: 'anon', claims: null }, url)
  }

  function latestLink(): URL {
    const link = mailer.list()[0]?.link
    if (!link) throw new Error('Expected an auth email link')
    return new URL(link)
  }

  test('preserves the signup confirmation redirect', async () => {
    const response = await request('signup', {
      email: 'signup-redirect@example.test',
      password: 'correct-horse-battery-staple',
    }, 'http://app.local/signup-done')

    expect(response.status).toBe(200)
    expect(latestLink().searchParams.get('redirect_to')).toBe('http://app.local/signup-done')
  })

  test('preserves the email OTP redirect', async () => {
    const response = await request('otp', {
      email: 'otp-redirect@example.test',
    }, 'http://app.local/otp-done')

    expect(response.status).toBe(200)
    expect(latestLink().searchParams.get('redirect_to')).toBe('http://app.local/otp-done')
  })

  test('preserves the recovery redirect', async () => {
    await db!.query(
      `insert into auth.users (email, email_confirmed_at)
       values ('recovery-redirect@example.test', now())`,
    )
    const response = await request('recover', {
      email: 'recovery-redirect@example.test',
    }, 'http://app.local/recovery-done')

    expect(response.status).toBe(200)
    expect(latestLink().searchParams.get('redirect_to')).toBe('http://app.local/recovery-done')
  })
})
