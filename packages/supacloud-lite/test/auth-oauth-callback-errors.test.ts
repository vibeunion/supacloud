import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'

describe('Auth OAuth callback errors', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  const jwtSecret = 'oauth-callback-errors-secret'.repeat(2)

  beforeAll(async () => { db = await Database.create() }, 60_000)
  afterEach(async () => {
    await db!.exec('drop trigger reject_oauth_identity on auth.identities; drop function public.reject_oauth_identity();')
    await auth?.stop()
  })
  afterAll(async () => { await db?.close() })

  test('redirects a sanitized error when OAuth account linking fails', async () => {
    auth = new AuthHandler(db!, {
      jwtSecret,
      apiUrl: 'http://lite.local',
      siteUrl: 'http://app.local/callback',
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
        if (url.pathname === '/userinfo') return Response.json({
          sub: 'provider-user',
          email: 'oauth-callback-errors@example.test',
          email_verified: true,
        })
        return new Response(null, { status: 404 })
      }) as typeof fetch,
    })
    await db!.exec(`
      create function public.reject_oauth_identity() returns trigger language plpgsql as $$
      begin
        raise exception 'oauth database details must stay private';
      end $$;
      create trigger reject_oauth_identity before insert on auth.identities
        for each row execute function public.reject_oauth_identity();
    `)

    const authorizeUrl = new URL('http://lite.local/auth/v1/authorize?provider=google&redirect_to=http%3A%2F%2Fapp.local%2Fcallback')
    const authorized = await auth.handle(new Request(authorizeUrl), { role: 'anon', claims: null }, authorizeUrl)
    const state = new URL(authorized.headers.get('location')!).searchParams.get('state')!
    const callbackUrl = new URL(`http://lite.local/auth/v1/callback?code=provider-code&state=${encodeURIComponent(state)}`)
    const callback = await auth.handle(new Request(callbackUrl), { role: 'anon', claims: null }, callbackUrl)

    expect(callback.status).toBe(303)
    const fragment = new URLSearchParams(new URL(callback.headers.get('location')!).hash.slice(1))
    expect(fragment.get('error')).toBe('server_error')
    expect(fragment.get('error_description')).toBe('OAuth callback failed')
    expect(fragment.toString()).not.toContain('oauth database details must stay private')
  })
})
