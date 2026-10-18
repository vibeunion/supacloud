import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'

describe('Auth OAuth redirect URL construction', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  const verifier = 'oauth-redirect-query-verifier'

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.flow_state; delete from auth.users;')
    auth = new AuthHandler(db!, {
      jwtSecret: 'oauth-redirect-query-secret'.repeat(2),
      apiUrl: 'http://lite.local',
      siteUrl: 'http://app.local/default',
      jwtExpiry: 3600,
      mailer: new InboxMailer(),
      rateLimiter: null,
      oauthProviders: {
        google: {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          authorizeUrl: 'http://provider.local/authorize',
          tokenUrl: 'http://provider.local/token',
          userInfoUrl: 'http://provider.local/userinfo',
        },
      },
      oauthFetch: (async (input) => {
        const url = new URL(String(input))
        if (url.pathname === '/token') return Response.json({ access_token: 'provider-token' })
        if (url.pathname === '/userinfo') {
          return Response.json({ sub: 'provider-user', email: 'oauth-redirect@example.test', email_verified: true })
        }
        return new Response(null, { status: 404 })
      }) as typeof fetch,
    })
  })
  afterEach(async () => { await auth?.stop() })
  afterAll(async () => { await db?.close() })

  test('preserves redirect query parameters during PKCE callback', async () => {
    const challenge = Buffer.from(await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(verifier),
    )).toString('base64url')
    const authorizeUrl = new URL('http://lite.local/auth/v1/authorize?provider=google')
    authorizeUrl.searchParams.set('redirect_to', 'http://app.local/callback?source=oauth')
    authorizeUrl.searchParams.set('code_challenge', challenge)
    authorizeUrl.searchParams.set('code_challenge_method', 's256')

    const authorized = await auth!.handle(new Request(authorizeUrl), { role: 'anon', claims: null }, authorizeUrl)
    const state = new URL(authorized.headers.get('location')!).searchParams.get('state')!
    const callbackUrl = new URL('http://lite.local/auth/v1/callback')
    callbackUrl.searchParams.set('code', 'provider-code')
    callbackUrl.searchParams.set('state', state)
    const callback = await auth!.handle(new Request(callbackUrl), { role: 'anon', claims: null }, callbackUrl)

    expect(callback.status).toBe(303)
    const location = new URL(callback.headers.get('location')!)
    expect(location.origin + location.pathname).toBe('http://app.local/callback')
    expect(location.searchParams.get('source')).toBe('oauth')
    expect(location.searchParams.get('code')).toBeString()
  })

  test('forwards client OAuth query parameters to the provider', async () => {
    const authorizeUrl = new URL('http://lite.local/auth/v1/authorize?provider=google')
    authorizeUrl.searchParams.set('query_param', 'from-client')
    authorizeUrl.searchParams.set('prompt', 'consent')
    authorizeUrl.searchParams.set('access_type', 'offline')
    authorizeUrl.searchParams.set('client_id', 'attacker-value')
    authorizeUrl.searchParams.set('response_type', 'token')
    authorizeUrl.searchParams.set('redirect_uri', 'https://attacker.example/callback')
    authorizeUrl.searchParams.set('scope', 'admin')
    authorizeUrl.searchParams.set('state', 'attacker-state')

    const authorized = await auth!.handle(new Request(authorizeUrl), { role: 'anon', claims: null }, authorizeUrl)
    const location = new URL(authorized.headers.get('location')!)

    expect(location.searchParams.get('query_param')).toBe('from-client')
    expect(location.searchParams.get('prompt')).toBe('consent')
    expect(location.searchParams.get('access_type')).toBe('offline')
    expect(location.searchParams.get('client_id')).toBe('client-id')
    expect(location.searchParams.get('response_type')).toBe('code')
    expect(location.searchParams.get('redirect_uri')).toBe('http://lite.local/auth/v1/callback')
    expect(location.searchParams.get('scope')).toBe('openid email profile')
    expect(location.searchParams.get('state')).not.toBe('attacker-state')
  })
})
