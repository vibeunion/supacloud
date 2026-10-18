import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'
import { verifyJwt } from '../src/runtime/jwt.js'

describe('Auth anonymous session claims', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  const jwtSecret = 'anonymous-claims-secret'.repeat(3)

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

  test('marks anonymous sessions in both user metadata and JWT AMR', async () => {
    const url = new URL('http://lite.local/auth/v1/signup')
    const response = await auth!.handle(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { source: 'anonymous' } }),
    }), { role: 'anon', claims: null }, url)

    expect(response.status).toBe(200)
    const body = await response.json() as {
      access_token: string
      user: { app_metadata: Record<string, unknown>; is_anonymous: boolean }
    }
    expect(body.user).toMatchObject({
      app_metadata: { provider: 'anonymous', providers: ['anonymous'] },
      is_anonymous: true,
    })
    expect(await verifyJwt(body.access_token, jwtSecret)).toMatchObject({
      is_anonymous: true,
      app_metadata: { provider: 'anonymous', providers: ['anonymous'] },
      amr: [{ method: 'anonymous', timestamp: expect.any(Number) }],
    })
  })
})
