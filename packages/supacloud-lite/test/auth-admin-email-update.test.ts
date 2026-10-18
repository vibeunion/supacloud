import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'

describe('Auth admin email updates', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  let userId: string
  const jwtSecret = 'admin-email-update-secret'.repeat(2)

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.users;')
    userId = (await db!.query<{ id: string }>(
      `insert into auth.users (email, email_confirmed_at) values ('admin-target@example.test', now()) returning id`,
    )).rows[0].id
    await db!.query(
      `insert into auth.users (email, email_confirmed_at) values ('admin-taken@example.test', now())`,
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

  test('returns email_exists instead of a database error for a duplicate email', async () => {
    const url = new URL(`http://lite.local/auth/v1/admin/users/${userId}`)
    const response = await auth!.handle(new Request(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin-taken@example.test' }),
    }), { role: 'service_role', claims: null }, url)

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error_code: 'email_exists' })
    expect((await db!.query(
      `select email from auth.users where id = $1`,
      [userId],
    )).rows).toEqual([{ email: 'admin-target@example.test' }])
  })
})
