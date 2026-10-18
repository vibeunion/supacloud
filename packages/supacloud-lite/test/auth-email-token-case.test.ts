import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'

describe('Auth email token casing', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  let userId: string
  const userEmail = 'mixedcase@example.test'
  const tokenEmail = 'MixedCase@Example.test'
  const token = 'mixed-case-token'
  const jwtSecret = 'email-token-case-secret'.repeat(2)

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.users;')
    userId = (await db!.query<{ id: string }>(
      `insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id`,
      [userEmail],
    )).rows[0].id
    await db!.query(
      `insert into auth.one_time_tokens (user_id, email, token_type, token, expires_at)
       values ($1, $2, 'magiclink', $3, now() + interval '1 hour')`,
      [userId, tokenEmail, token],
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

  test('redeems a token whose stored email casing differs from the request', async () => {
    const url = new URL('http://lite.local/auth/v1/verify')
    const response = await auth!.handle(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, email: tokenEmail.toLowerCase(), type: 'magiclink' }),
    }), { role: 'anon', claims: null }, url)

    expect(response.status).toBe(200)
    expect((await response.json()) as { access_token: string }).toHaveProperty('access_token')
    expect((await db!.query('select user_id from auth.refresh_tokens')).rows).toEqual([{ user_id: userId }])
    expect((await db!.query('select id from auth.one_time_tokens')).rows).toEqual([])
  })
})
