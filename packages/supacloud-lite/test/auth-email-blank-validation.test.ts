import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { DEFAULT_AUTH_SETTINGS } from '../src/runtime/auth/settings.js'
import { Database } from '../src/runtime/db/database.js'

describe('Auth blank email validation', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.users;')
    auth = new AuthHandler(db!, {
      jwtSecret: 'blank-email-validation-secret'.repeat(2),
      apiUrl: 'http://lite.local',
      siteUrl: 'http://app.local',
      jwtExpiry: 3600,
      mailer: new InboxMailer(),
      rateLimiter: null,
      settings: { ...DEFAULT_AUTH_SETTINGS, autoconfirm: true },
    })
  })
  afterEach(async () => { await auth?.stop() })
  afterAll(async () => { await db?.close() })

  async function request(path: string, body: Record<string, unknown>, ctx: { role: string; claims: null | Record<string, unknown> } = {
    role: 'anon',
    claims: null,
  }): Promise<Response> {
    const url = new URL(`http://lite.local/auth/v1/${path}`)
    return auth!.handle(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), ctx, url)
  }

  test('rejects whitespace-only email across email auth entry points', async () => {
    for (const [path, body, ctx] of [
      ['signup', { email: '   ', password: 'correct-horse-battery-staple' }, { role: 'anon', claims: null }],
      ['otp', { email: '   ' }, { role: 'anon', claims: null }],
      ['recover', { email: '   ' }, { role: 'anon', claims: null }],
      ['admin/users', { email: '   ' }, { role: 'service_role', claims: null }],
      ['admin/generate_link', { type: 'magiclink', email: '   ' }, { role: 'service_role', claims: null }],
    ] as const) {
      const response = await request(path, body, ctx)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error_code: 'validation_failed' })
    }

    expect((await db!.query('select id from auth.users')).rows).toEqual([])
  })

  test('rejects whitespace-only email updates without changing the account', async () => {
    const signup = await request('signup', {
      email: 'blank-email-update@example.test',
      password: 'correct-horse-battery-staple',
    })
    expect(signup.status).toBe(200)
    const session = await signup.json() as { access_token: string; user: { id: string; email: string } }

    const url = new URL('http://lite.local/auth/v1/user')
    const response = await auth!.handle(new Request(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${session.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: '   ' }),
    }), { role: 'authenticated', claims: null }, url)

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error_code: 'validation_failed' })
    expect((await db!.query<{ email: string }>('select email from auth.users')).rows)
      .toEqual([{ email: session.user.email }])
  })
})
