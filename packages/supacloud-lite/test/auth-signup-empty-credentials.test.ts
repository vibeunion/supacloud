import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'

describe('Auth signup credential validation', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.users;')
    auth = new AuthHandler(db!, {
      jwtSecret: 'signup-empty-credentials-secret'.repeat(2),
      apiUrl: 'http://lite.local',
      siteUrl: 'http://app.local',
      jwtExpiry: 3600,
      mailer: new InboxMailer(),
      rateLimiter: null,
    })
  })
  afterEach(async () => { await auth?.stop() })
  afterAll(async () => { await db?.close() })

  test('rejects explicit empty email and password instead of creating an anonymous user', async () => {
    const url = new URL('http://lite.local/auth/v1/signup')
    const response = await auth!.handle(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: '', password: '' }),
    }), { role: 'anon', claims: null }, url)

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error_code: 'validation_failed' })
    expect((await db!.query('select id from auth.users')).rows).toEqual([])
  })

  test('keeps data-only anonymous signup working when credentials are omitted', async () => {
    const url = new URL('http://lite.local/auth/v1/signup')
    const response = await auth!.handle(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { source: 'test' } }),
    }), { role: 'anon', claims: null }, url)

    expect(response.status).toBe(200)
    expect((await response.json()) as { user: { is_anonymous: boolean } }).toMatchObject({
      user: { is_anonymous: true },
    })
    expect((await db!.query<{ is_anonymous: boolean; raw_user_meta_data: Record<string, unknown> }>(
      'select is_anonymous, raw_user_meta_data from auth.users',
    )).rows).toEqual([{ is_anonymous: true, raw_user_meta_data: { source: 'test' } }])
  })
})
