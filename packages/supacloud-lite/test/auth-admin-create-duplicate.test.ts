import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'

describe('Auth admin user creation', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  const jwtSecret = 'admin-create-duplicate-secret'.repeat(2)

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

  test('returns email_exists instead of a database error for duplicate email', async () => {
    const url = new URL('http://lite.local/auth/v1/admin/users')
    const request = () => auth!.handle(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'admin-duplicate@example.test',
        password: 'correct-horse-battery-staple',
        email_confirm: true,
      }),
    }), { role: 'service_role', claims: null }, url)

    expect((await request()).status).toBe(200)
    const duplicate = await request()
    expect(duplicate.status).toBe(422)
    expect(await duplicate.json()).toMatchObject({ error_code: 'email_exists' })
    expect((await db!.query(
      `select count(*)::int as count from auth.users where email = 'admin-duplicate@example.test'`,
    )).rows).toEqual([{ count: 1 }])
  })
})
