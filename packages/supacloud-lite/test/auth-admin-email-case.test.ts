import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'

describe('Auth admin email casing', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  let userId: string
  const storedEmail = 'MixedCase@Example.test'
  const jwtSecret = 'admin-email-case-secret'.repeat(2)

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.users;')
    userId = (await db!.query<{ id: string }>(
      `insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id`,
      [storedEmail],
    )).rows[0].id
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

  function serviceRequest(path: string, method: 'POST' | 'PUT', body: Record<string, unknown>): Promise<Response> {
    const url = new URL(`http://lite.local/auth/v1/${path}`)
    return auth!.handle(new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), { role: 'service_role', claims: null }, url)
  }

  test('rejects admin creation and update when only casing differs', async () => {
    const created = await serviceRequest('admin/users', 'POST', {
      email: storedEmail.toLowerCase(),
      password: 'correct-horse-battery-staple',
    })
    expect(created.status).toBe(422)
    expect((await created.json()) as { error_code: string }).toMatchObject({ error_code: 'email_exists' })

    const secondId = (await db!.query<{ id: string }>(
      `insert into auth.users (email, email_confirmed_at) values ('second@example.test', now()) returning id`,
    )).rows[0].id
    const updated = await serviceRequest(`admin/users/${secondId}`, 'PUT', {
      email: storedEmail.toLowerCase(),
    })
    expect(updated.status).toBe(422)
    expect((await updated.json()) as { error_code: string }).toMatchObject({ error_code: 'email_exists' })
    expect((await db!.query('select email from auth.users order by email')).rows).toEqual([
      { email: 'MixedCase@Example.test' },
      { email: 'second@example.test' },
    ])
  })

  test('reuses an imported account when generating an admin magic link', async () => {
    const response = await serviceRequest('admin/generate_link', 'POST', {
      type: 'magiclink',
      email: storedEmail.toLowerCase(),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { id: string }
    expect(body.id).toBe(userId)
    expect((await db!.query('select id from auth.users')).rows).toHaveLength(1)
  })
})
