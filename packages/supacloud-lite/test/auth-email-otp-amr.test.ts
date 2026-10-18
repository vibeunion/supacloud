import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'
import { DEFAULT_AUTH_SETTINGS } from '../src/runtime/auth/settings.js'
import { verifyJwt } from '../src/runtime/jwt.js'

describe('Auth email OTP session AMR', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  const secret = 'email-otp-amr-secret'.repeat(2)

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.one_time_tokens; delete from auth.users;')
    auth = new AuthHandler(db!, {
      jwtSecret: secret,
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

  test('marks a passwordless email verification as OTP authentication', async () => {
    const userId = await createUser('otp-amr@example.test')
    await issueToken(userId, 'otp-amr@example.test', '123456', 'otp')
    const response = await verify('otp-amr@example.test', '123456', 'email')
    expect(response.status).toBe(200)
    const body = await response.json() as { access_token: string }
    expect(await verifyJwt(body.access_token, secret)).toMatchObject({
      sub: userId,
      amr: [{ method: 'otp', timestamp: expect.any(Number) }],
    })
  })

  test('marks a recovery verification as recovery authentication', async () => {
    const userId = await createUser('recovery-amr@example.test')
    await issueToken(userId, 'recovery-amr@example.test', '654321', 'recovery')
    const response = await verify('recovery-amr@example.test', '654321', 'recovery')
    expect(response.status).toBe(200)
    const body = await response.json() as { access_token: string }
    expect(await verifyJwt(body.access_token, secret)).toMatchObject({
      sub: userId,
      amr: [{ method: 'recovery', timestamp: expect.any(Number) }],
    })
  })

  async function createUser(email: string): Promise<string> {
    return (await db!.query<{ id: string }>(
      `insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id`,
      [email],
    )).rows[0]!.id
  }

  async function issueToken(userId: string, email: string, token: string, type: 'otp' | 'recovery'): Promise<void> {
    await db!.query(
      `insert into auth.one_time_tokens (user_id, email, token_type, token, expires_at)
       values ($1, $2, $3, $4, now() + interval '1 hour')`,
      [userId, email, type, token],
    )
  }

  function verify(email: string, token: string, type: string): Promise<Response> {
    const url = new URL('http://lite.local/auth/v1/verify')
    return auth!.handle(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, token, type }),
    }), { role: 'anon', claims: null }, url)
  }
})
