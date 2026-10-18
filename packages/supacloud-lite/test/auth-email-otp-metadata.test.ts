import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'

describe('Auth email OTP metadata', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.users;')
    auth = new AuthHandler(db!, {
      jwtSecret: 'email-otp-metadata-secret'.repeat(2),
      apiUrl: 'http://lite.local',
      siteUrl: 'http://app.local',
      jwtExpiry: 3600,
      mailer: new InboxMailer(),
      rateLimiter: null,
    })
  })
  afterEach(async () => { await auth?.stop() })
  afterAll(async () => { await db?.close() })

  test('persists options.data when email OTP creates a user', async () => {
    const url = new URL('http://lite.local/auth/v1/otp')
    const response = await auth!.handle(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'email-otp-metadata@example.test',
        create_user: true,
        data: { display_name: 'Email OTP' },
      }),
    }), { role: 'anon', claims: null }, url)

    expect(response.status).toBe(200)
    expect((await db!.query<{ raw_user_meta_data: Record<string, unknown> }>(
      'select raw_user_meta_data from auth.users',
    )).rows).toEqual([{ raw_user_meta_data: { display_name: 'Email OTP' } }])
  })
})
