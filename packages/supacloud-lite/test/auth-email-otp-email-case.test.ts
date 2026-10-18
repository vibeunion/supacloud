import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'

describe('Auth email OTP casing', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  let userId: string
  const storedEmail = 'MixedCase@Example.test'
  const jwtSecret = 'email-otp-email-case-secret'.repeat(2)

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.users;')
    userId = (await db!.query<{ id: string }>(
      `insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id`,
      [storedEmail],
    )).rows[0].id
    await db!.query(
      `insert into auth.one_time_tokens (user_id, email, token_type, token, expires_at)
       values ($1, $2, 'otp', 'stale-code', now() + interval '1 hour')`,
      [userId, storedEmail],
    )
    auth = new AuthHandler(db!, {
      jwtSecret,
      apiUrl: 'http://lite.local',
      siteUrl: 'http://app.local',
      jwtExpiry: 3600,
      mailer: new InboxMailer(),
      rateLimiter: null,
    })
  })
  afterEach(async () => { await auth?.stop() })
  afterAll(async () => { await db?.close() })

  test('issues OTP and magic link tokens for an imported mixed-case account', async () => {
    const url = new URL('http://lite.local/auth/v1/otp')
    const response = await auth!.handle(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: storedEmail.toLowerCase(), create_user: false }),
    }), { role: 'anon', claims: null }, url)

    expect(response.status).toBe(200)
    expect((await db!.query(
      `select user_id, email, token_type from auth.one_time_tokens
       order by token_type`,
    )).rows).toEqual([
      { user_id: userId, email: storedEmail.toLowerCase(), token_type: 'magiclink' },
      { user_id: userId, email: storedEmail.toLowerCase(), token_type: 'otp' },
    ])
  })
})
