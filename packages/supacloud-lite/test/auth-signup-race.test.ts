import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'

describe('Auth signup duplicate handling', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  const jwtSecret = 'signup-race-secret'.repeat(4)

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

  test('returns user_already_exists for the losing concurrent signup', async () => {
    const url = new URL('http://lite.local/auth/v1/signup')
    const request = () => auth!.handle(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'signup-race@example.test',
        password: 'correct-horse-battery-staple',
      }),
    }), { role: 'anon', claims: null }, url)

    const responses = await Promise.all([request(), request()])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 422])
    expect((await db!.query('select id from auth.users where email = $1', ['signup-race@example.test'])).rows)
      .toHaveLength(1)
  })
})
