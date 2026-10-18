import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'
import { signJwt } from '../src/runtime/jwt.js'

describe('Auth user email casing', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  let userId: string
  const storedEmail = 'MixedCase@Example.test'
  const jwtSecret = 'user-email-case-secret'.repeat(2)

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.users;')
    await db!.query(
      `insert into auth.users (email, email_confirmed_at) values ($1, now())`,
      [storedEmail],
    )
    userId = (await db!.query<{ id: string }>(
      `insert into auth.users (email, email_confirmed_at) values ('second@example.test', now()) returning id`,
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

  test('rejects changing an email to an existing address with different casing', async () => {
    const accessToken = await signJwt({
      sub: userId,
      role: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, jwtSecret)
    const url = new URL('http://lite.local/auth/v1/user')
    const response = await auth!.handle(new Request(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: storedEmail.toLowerCase() }),
    }), { role: 'anon', claims: null }, url)

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error_code: 'email_exists' })
    expect((await db!.query('select email from auth.users order by email')).rows).toEqual([
      { email: 'MixedCase@Example.test' },
      { email: 'second@example.test' },
    ])
  })
})
