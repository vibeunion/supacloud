import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'

describe('Auth passwordless email identity', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  const email = 'otp-identity@example.test'
  const jwtSecret = 'email-otp-identity-secret'.repeat(2)

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.users;')
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

  test('records the email identity when an OTP creates the account', async () => {
    const otpUrl = new URL('http://lite.local/auth/v1/otp')
    const issued = await auth!.handle(new Request(otpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, create_user: true }),
    }), { role: 'anon', claims: null }, otpUrl)
    expect(issued.status).toBe(200)

    const code = (await db!.query<{ token: string }>(
      `select token from auth.one_time_tokens where email = $1 and token_type = 'otp'`,
      [email],
    )).rows[0]?.token
    if (!code) throw new Error('Expected an issued email OTP')

    const verifyUrl = new URL('http://lite.local/auth/v1/verify')
    const verified = await auth!.handle(new Request(verifyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, token: code, type: 'email' }),
    }), { role: 'anon', claims: null }, verifyUrl)
    expect(verified.status).toBe(200)
    const body = await verified.json() as { user: { identities: Array<{ provider: string }> } }
    expect(body.user.identities).toEqual([expect.objectContaining({ provider: 'email' })])
  })
})
