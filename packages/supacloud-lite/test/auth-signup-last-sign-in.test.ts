import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { DEFAULT_AUTH_SETTINGS } from '../src/runtime/auth/settings.js'
import { Database } from '../src/runtime/db/database.js'

describe('Auth signup sign-in timestamps', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  const email = 'signup-last-sign-in@example.test'
  const password = 'correct-horse-battery-staple'

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.users;')
    auth = new AuthHandler(db!, {
      jwtSecret: 'signup-last-sign-in-secret'.repeat(2),
      apiUrl: 'http://lite.local',
      siteUrl: 'http://app.local',
      jwtExpiry: 3600,
      mailer: new InboxMailer(),
      rateLimiter: null,
      settings: { ...DEFAULT_AUTH_SETTINGS, autoconfirm: false },
    })
  })
  afterEach(async () => { await auth?.stop() })
  afterAll(async () => { await db?.close() })

  test('leaves last_sign_in_at unset when signup requires email confirmation', async () => {
    const url = new URL('http://lite.local/auth/v1/signup')
    const response = await auth!.handle(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }), { role: 'anon', claims: null }, url)

    expect(response.status).toBe(200)
    expect((await response.json()) as { session?: unknown }).not.toHaveProperty('session')
    expect((await db!.query<{ email_confirmed_at: string | null; last_sign_in_at: string | null }>(
      `select email_confirmed_at::text, last_sign_in_at::text
       from auth.users where email = $1`,
      [email],
    )).rows).toEqual([{ email_confirmed_at: null, last_sign_in_at: null }])
  })
})
