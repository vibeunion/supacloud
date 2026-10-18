import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { hashPassword } from '../src/runtime/auth/password.js'
import { Database } from '../src/runtime/db/database.js'
import { verifyJwt } from '../src/runtime/jwt.js'

describe('Auth password login email casing', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  const storedEmail = 'MixedCase@Example.test'
  const password = 'correct-horse-battery-staple'
  const jwtSecret = 'password-email-case-secret'.repeat(2)

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.users;')
    await db!.query(
      `insert into auth.users (email, encrypted_password, email_confirmed_at)
       values ($1, $2, now())`,
      [storedEmail, await hashPassword(password)],
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

  test('signs in an imported account with a differently cased email', async () => {
    const url = new URL('http://lite.local/auth/v1/token?grant_type=password')
    const response = await auth!.handle(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: storedEmail.toLowerCase(), password }),
    }), { role: 'anon', claims: null }, url)

    expect(response.status).toBe(200)
    const body = await response.json() as { access_token: string; user: { email: string } }
    expect(body.user.email).toBe(storedEmail)
    expect(await verifyJwt(body.access_token, jwtSecret)).toMatchObject({ email: storedEmail })
  })
})
