import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { DEFAULT_AUTH_SETTINGS } from '../src/runtime/auth/settings.js'
import { Database } from '../src/runtime/db/database.js'

describe('Auth signup confirmation resend', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  let mailer: InboxMailer

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.one_time_tokens; delete from auth.users;')
    mailer = new InboxMailer()
    auth = new AuthHandler(db!, {
      jwtSecret: 'resend-signup-secret'.repeat(2),
      apiUrl: 'http://lite.local',
      siteUrl: 'http://app.local',
      jwtExpiry: 3600,
      mailer,
      rateLimiter: null,
      settings: { ...DEFAULT_AUTH_SETTINGS, autoconfirm: false },
    })
  })
  afterEach(async () => { await auth?.stop() })
  afterAll(async () => { await db?.close() })

  test('resends confirmation for an existing unconfirmed user without creating unknown users', async () => {
    await db!.query(
      `insert into auth.users (email, encrypted_password)
       values ('resend-signup@example.test', 'password-hash')`,
    )
    const url = new URL('http://lite.local/auth/v1/resend?redirect_to=http%3A%2F%2Fapp.local%2Fconfirmed')
    const response = await auth!.handle(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'signup', email: 'resend-signup@example.test' }),
    }), { role: 'anon', claims: null }, url)

    expect(response.status).toBe(200)
    expect(mailer.list()[0]?.subject).toBe('Confirm your email')
    expect(new URL(mailer.list()[0]?.link ?? '').searchParams.get('redirect_to'))
      .toBe('http://app.local/confirmed')

    const unknown = await auth!.handle(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'signup', email: 'unknown-resend@example.test' }),
    }), { role: 'anon', claims: null }, url)
    expect(unknown.status).toBe(200)
    expect((await db!.query(
      `select email from auth.users order by email`,
    )).rows).toEqual([{ email: 'resend-signup@example.test' }])
  })
})
