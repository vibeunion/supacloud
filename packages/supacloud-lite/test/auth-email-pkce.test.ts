import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { DEFAULT_AUTH_SETTINGS } from '../src/runtime/auth/settings.js'
import { Database } from '../src/runtime/db/database.js'

describe('Auth email PKCE flows', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  let mailer: InboxMailer

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
      jwtSecret: 'email-pkce-secret'.repeat(2),
      apiUrl: 'http://lite.local',
      siteUrl: 'http://app.local/default',
      jwtExpiry: 3600,
      mailer,
      rateLimiter: null,
      settings: { ...DEFAULT_AUTH_SETTINGS, autoconfirm: false },
    })
  })
  afterEach(async () => { await auth?.stop() })
  afterAll(async () => { await db?.close() })

  test('exchanges a signup confirmation link through PKCE and preserves redirect query', async () => {
    const verifier = 'signup-email-pkce-verifier'
    const challenge = await pkceChallenge(verifier)
    const signup = await request('signup', {
      email: 'signup-pkce@example.test',
      password: 'correct-horse-battery-staple',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }, 'http://app.local/auth/callback?state=signup&source=email')

    expect(signup.status).toBe(200)
    const verify = await followLatestLink()
    const callback = new URL(verify.headers.get('location')!)
    expect(verify.status).toBe(303)
    expect(callback.searchParams.get('state')).toBe('signup')
    expect(callback.searchParams.get('source')).toBe('email')
    expect(callback.searchParams.get('code')).toBeTruthy()

    const exchanged = await exchange(callback.searchParams.get('code')!, verifier)
    expect(exchanged.status).toBe(200)
    expect((await exchanged.json()).user.email).toBe('signup-pkce@example.test')
  })

  test('exchanges an email OTP link through PKCE after a failed verifier attempt', async () => {
    const verifier = 'otp-email-pkce-verifier'
    const sent = await request('otp', {
      email: 'otp-pkce@example.test',
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: 's256',
    }, 'http://app.local/otp/callback?tab=email')
    expect(sent.status).toBe(200)

    const verify = await followLatestLink()
    const callback = new URL(verify.headers.get('location')!)
    const authCode = callback.searchParams.get('code')
    expect(authCode).toBeTruthy()

    const rejected = await exchange(authCode!, 'wrong-verifier')
    expect(rejected.status).toBe(403)
    expect((await rejected.json()).error_code).toBe('flow_state_not_found')

    const exchanged = await exchange(authCode!, verifier)
    expect(exchanged.status).toBe(200)
    expect((await exchanged.json()).user.email).toBe('otp-pkce@example.test')
  })

  test('exchanges a recovery link through PKCE and marks the session as recovery-authenticated', async () => {
    const inserted = await db!.query<{ id: string }>(
      `insert into auth.users (email, email_confirmed_at)
       values ('recovery-pkce@example.test', now())
       returning id`,
    )
    const verifier = 'recovery-email-pkce-verifier'
    const sent = await request('recover', {
      email: 'recovery-pkce@example.test',
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: 's256',
    }, 'http://app.local/recovery/callback?mode=reset')
    expect(sent.status).toBe(200)

    const verify = await followLatestLink()
    const callback = new URL(verify.headers.get('location')!)
    const exchanged = await exchange(callback.searchParams.get('code')!, verifier)
    expect(exchanged.status).toBe(200)
    const body = await exchanged.json() as { access_token: string; user: { id: string } }
    expect(body.user.id).toBe(inserted.rows[0]?.id)
    expect(jwtPayload(body.access_token).amr).toEqual([{ method: 'recovery', timestamp: expect.any(Number) }])
  })

  async function request(path: string, body: Record<string, unknown>, redirectTo: string): Promise<Response> {
    const url = new URL(`http://lite.local/auth/v1/${path}`)
    url.searchParams.set('redirect_to', redirectTo)
    return auth!.handle(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), { role: 'anon', claims: null }, url)
  }

  async function followLatestLink(): Promise<Response> {
    const link = mailer.list()[0]?.link
    if (!link) throw new Error('Expected an auth email link')
    const url = new URL(link)
    return auth!.handle(new Request(url), { role: 'anon', claims: null }, url)
  }

  function exchange(authCode: string, verifier: string): Promise<Response> {
    const url = new URL('http://lite.local/auth/v1/token?grant_type=pkce')
    return auth!.handle(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ auth_code: authCode, code_verifier: verifier }),
    }), { role: 'anon', claims: null }, url)
  }
})

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return Buffer.from(digest).toString('base64url')
}

function jwtPayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
}
