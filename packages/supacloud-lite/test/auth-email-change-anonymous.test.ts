import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'
import { DEFAULT_AUTH_SETTINGS } from '../src/runtime/auth/settings.js'
import { verifyJwt } from '../src/runtime/jwt.js'

describe('Auth email change anonymous upgrade', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  let mailer: InboxMailer
  const secret = 'email-change-anonymous-secret'.repeat(2)

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec(`
      delete from auth.refresh_tokens;
      delete from auth.identities;
      delete from auth.one_time_tokens;
      delete from auth.flow_state;
      delete from auth.users;
    `)
    mailer = new InboxMailer()
    auth = new AuthHandler(db!, {
      jwtSecret: secret,
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

  test('turns an anonymous account into a confirmed email account after verification', async () => {
    const signupUrl = new URL('http://lite.local/auth/v1/signup')
    const anonymous = await auth!.handle(new Request(signupUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { source: 'anonymous' } }),
    }), anonymousContext(), signupUrl)
    expect(anonymous.status).toBe(200)
    const anonymousToken = (await anonymous.json()).access_token as string

    const updateUrl = new URL('http://lite.local/auth/v1/user')
    const updated = await auth!.handle(new Request(updateUrl, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${anonymousToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: 'upgraded@example.test' }),
    }), anonymousContext(), updateUrl)
    expect(updated.status).toBe(200)

    const link = mailer.list()[0]?.link
    if (!link) throw new Error('Expected an email change link')
    const verifyUrl = new URL(link)
    const verified = await auth!.handle(new Request(verifyUrl), anonymousContext(), verifyUrl)
    expect(verified.status).toBe(303)
    const sessionToken = new URLSearchParams(new URL(verified.headers.get('location')!).hash.slice(1)).get('access_token')
    if (!sessionToken) throw new Error('Expected a verified session')
    expect(await verifyJwt(sessionToken, secret)).toMatchObject({
      is_anonymous: false,
      app_metadata: { provider: 'email', providers: ['email'] },
      email: 'upgraded@example.test',
    })
    expect((await db!.query<{ email: string; is_anonymous: boolean; app_metadata: Record<string, unknown> }>(
      `select email, is_anonymous, raw_app_meta_data as app_metadata from auth.users`,
    )).rows).toEqual([{
      email: 'upgraded@example.test',
      is_anonymous: false,
      app_metadata: { provider: 'email', providers: ['email'] },
    }])
  })
})

function anonymousContext() {
  return { role: 'anon' as const, claims: null }
}
