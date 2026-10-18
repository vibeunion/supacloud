import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'

describe('Auth email OTP issuance', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  const email = 'otp-race@example.test'
  const jwtSecret = 'email-otp-race-secret'.repeat(3)

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.users;')
    await db!.query(
      `insert into auth.users (email, email_confirmed_at) values ($1, now())`,
      [email],
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

  test('keeps only the latest email OTP and magic link pair', async () => {
    const url = new URL('http://lite.local/auth/v1/otp')
    const request = () => auth!.handle(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, create_user: false }),
    }), { role: 'anon', claims: null }, url)

    const responses = await Promise.all([request(), request()])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect((await db!.query(
      `select token_type from auth.one_time_tokens
       where email = $1 order by token_type`,
      [email],
    )).rows).toEqual([{ token_type: 'magiclink' }, { token_type: 'otp' }])
  })
})
