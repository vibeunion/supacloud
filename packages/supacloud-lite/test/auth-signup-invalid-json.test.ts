import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'

describe('Auth signup request parsing', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.users;')
    auth = new AuthHandler(db!, {
      jwtSecret: 'signup-invalid-json-secret'.repeat(2),
      apiUrl: 'http://lite.local',
      siteUrl: 'http://app.local',
      jwtExpiry: 3600,
      mailer: new InboxMailer(),
      rateLimiter: null,
    })
  })
  afterEach(async () => { await auth?.stop() })
  afterAll(async () => { await db?.close() })

  test('rejects malformed signup JSON without creating an anonymous user', async () => {
    const url = new URL('http://lite.local/auth/v1/signup')
    const response = await auth!.handle(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"data":',
    }), { role: 'anon', claims: null }, url)

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error_code: 'validation_failed' })
    expect((await db!.query('select id from auth.users')).rows).toEqual([])
  })

  test('keeps anonymous signup available for a valid JSON object', async () => {
    const url = new URL('http://lite.local/auth/v1/signup')
    const response = await auth!.handle(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { source: 'valid-json' } }),
    }), { role: 'anon', claims: null }, url)

    expect(response.status).toBe(200)
    expect((await response.json()) as { user: { is_anonymous: boolean } }).toMatchObject({
      user: { is_anonymous: true },
    })
  })
})
