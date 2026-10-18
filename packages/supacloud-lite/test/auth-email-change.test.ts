import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'
import { DEFAULT_AUTH_SETTINGS } from '../src/runtime/auth/settings.js'

describe('Auth email change confirmation', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  let mailer: InboxMailer
  let accessToken: string

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
      jwtSecret: 'email-change-secret'.repeat(2),
      apiUrl: 'http://lite.local',
      siteUrl: 'http://app.local/default',
      jwtExpiry: 3600,
      mailer,
      rateLimiter: null,
      settings: { ...DEFAULT_AUTH_SETTINGS, autoconfirm: false },
    })
    const created = await handle('/admin/users', 'POST', {
      email: 'before@example.test',
      password: 'correct-horse-battery-staple',
      email_confirm: true,
    }, { role: 'service_role', claims: null })
    expect(created.status).toBe(200)
    const login = await handle('/token?grant_type=password', 'POST', {
      email: 'before@example.test',
      password: 'correct-horse-battery-staple',
    }, { role: 'anon', claims: null })
    expect(login.status).toBe(200)
    accessToken = (await login.json()).access_token
  })
  afterEach(async () => { await auth?.stop() })
  afterAll(async () => { await db?.close() })

  test('confirms a PKCE email change and preserves redirect query parameters', async () => {
    const verifier = 'email-change-pkce-verifier'
    const update = await handle(
      '/user?redirect_to=http%3A%2F%2Fapp.local%2Fauth%2Fcallback%3Ftab%3Dsecurity',
      'PUT',
      { email: 'after@example.test', code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256' },
      authenticatedContext(),
    )
    expect(update.status).toBe(200)
    expect((await update.json()).new_email).toBe('after@example.test')

    const link = mailer.list()[0]?.link
    if (!link) throw new Error('Expected an email change link')
    const verifyUrl = new URL(link)
    const verified = await auth!.handle(new Request(verifyUrl), anonymousContext(), verifyUrl)
    expect(verified.status).toBe(303)
    const callback = new URL(verified.headers.get('location')!)
    expect(callback.searchParams.get('tab')).toBe('security')
    const authCode = callback.searchParams.get('code')
    expect(authCode).toBeTruthy()

    const wrong = await exchange(authCode!, 'wrong-verifier')
    expect(wrong.status).toBe(403)
    const exchanged = await exchange(authCode!, verifier)
    expect(exchanged.status).toBe(200)
    expect((await exchanged.json()).user.email).toBe('after@example.test')
    expect((await db!.query<{ email: string }>('select email from auth.users'))).toMatchObject({
      rows: [{ email: 'after@example.test' }],
    })
  })

  test('confirms an email change with the email OTP and consumes it once', async () => {
    const update = await handle('/user', 'PUT', { email: 'otp-after@example.test' }, authenticatedContext())
    expect(update.status).toBe(200)
    const code = mailer.list()[0]?.code
    if (!code) throw new Error('Expected an email change OTP')

    const verified = await handle('/verify', 'POST', {
      email: 'otp-after@example.test',
      token: code,
      type: 'email_change',
    }, anonymousContext())
    expect(verified.status).toBe(200)
    expect((await verified.json()).user.email).toBe('otp-after@example.test')

    const replay = await handle('/verify', 'POST', {
      email: 'otp-after@example.test',
      token: code,
      type: 'email_change',
    }, anonymousContext())
    expect(replay.status).toBe(403)
  })

  test('rejects an email change that races with another account claiming the address', async () => {
    const update = await handle('/user', 'PUT', { email: 'claimed@example.test' }, authenticatedContext())
    expect(update.status).toBe(200)
    await db!.query(
      `insert into auth.users (email, email_confirmed_at) values ('claimed@example.test', now())`,
    )
    const link = mailer.list()[0]?.link
    if (!link) throw new Error('Expected an email change link')
    const verifyUrl = new URL(link)
    const verified = await auth!.handle(new Request(verifyUrl), anonymousContext(), verifyUrl)
    expect(verified.status).toBe(303)
    expect(new URL(verified.headers.get('location')!).hash).toContain('error_code=otp_expired')
  })

  async function handle(
    path: string,
    method: 'POST' | 'PUT',
    body: Record<string, unknown>,
    ctx: { role: 'anon' | 'service_role'; claims: null },
  ): Promise<Response> {
    const url = new URL(`http://lite.local/auth/v1${path}`)
    return auth!.handle(new Request(url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(ctx.role === 'anon' ? {} : {}),
        ...(ctx.role === 'anon' && path.startsWith('/user') ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
    }), ctx, url)
  }

  function authenticatedContext() {
    return { role: 'anon' as const, claims: null }
  }

  function anonymousContext() {
    return { role: 'anon' as const, claims: null }
  }

  function exchange(authCode: string, verifier: string): Promise<Response> {
    return handle('/token?grant_type=pkce', 'POST', {
      auth_code: authCode,
      code_verifier: verifier,
    }, anonymousContext())
  }
})

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return Buffer.from(digest).toString('base64url')
}
