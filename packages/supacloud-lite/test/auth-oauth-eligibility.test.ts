import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { OAuthAccountIneligibleError, OAuthService } from '../src/runtime/auth/oauth.js'
import { Database } from '../src/runtime/db/database.js'
import { verifyJwt } from '../src/runtime/jwt.js'

describe('OAuth account eligibility', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  let userId: string
  const secret = 'oauth-eligibility-secret'.repeat(3)
  const email = 'oauth-eligibility@example.test'
  const verifier = 'oauth-eligibility-code-verifier'
  const states = [
    { name: 'banned', sql: "banned_until = now() + interval '1 hour'", code: 'user_banned' },
    { name: 'indefinitely banned', sql: "banned_until = 'infinity'", code: 'user_banned' },
    { name: 'soft-deleted', sql: 'deleted_at = now()', code: 'user_not_found' },
  ]

  beforeAll(async () => {
    db = await Database.create()
  }, 60_000)

  beforeEach(async () => {
    await db!.exec('delete from auth.flow_state; delete from auth.users;')
    const created = await db!.query<{ id: string }>(
      `insert into auth.users (email, email_confirmed_at, last_sign_in_at)
       values ($1, now(), '2000-01-01') returning id`,
      [email],
    )
    userId = created.rows[0].id
    auth = new AuthHandler(db!, {
      jwtSecret: secret, apiUrl: 'http://lite.local', siteUrl: 'http://app.local/callback',
      jwtExpiry: 3600, mailer: new InboxMailer(), rateLimiter: null,
      oauthProviders: {
        google: {
          clientId: 'test-client', clientSecret: 'test-secret',
          tokenUrl: 'http://provider.local/token', userInfoUrl: 'http://provider.local/userinfo',
        },
      },
      oauthFetch: (async (input) => {
        const url = new URL(String(input))
        if (url.pathname === '/token') return Response.json({ access_token: 'provider-token' })
        if (url.pathname === '/userinfo') {
          return Response.json({ sub: 'provider-user', email, email_verified: true })
        }
        return new Response(null, { status: 404 })
      }) as typeof fetch,
    })
  })

  afterEach(async () => { await auth?.stop() })
  afterAll(async () => { await db?.close() })

  function request(path: string, body?: Record<string, unknown>) {
    const url = new URL(`http://lite.local/auth/v1/${path}`)
    return auth!.handle(new Request(url, {
      method: body ? 'POST' : 'GET',
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    }), { role: 'anon', claims: null }, url)
  }

  async function callback(pkce: boolean): Promise<URL> {
    const params = new URLSearchParams({ provider: 'google' })
    if (pkce) {
      params.set('code_challenge', Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url'))
      params.set('code_challenge_method', 's256')
    }
    const start = await request(`authorize?${params}`)
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!
    const response = await request(`callback?code=test-code&state=${state}`)
    expect(response.status).toBe(303)
    return new URL(response.headers.get('location')!)
  }

  async function linkIdentity() {
    await db!.query(
      `insert into auth.identities (user_id, provider, provider_id, identity_data)
       values ($1, 'google', 'provider-user', '{"before":true}')`,
      [userId],
    )
  }

  async function expectNoSession() {
    expect((await db!.query('select token from auth.refresh_tokens')).rows).toEqual([])
  }

  for (const pkce of [false, true]) {
    for (const linked of [false, true]) {
      for (const state of states) {
        test(`rejects ${state.name} ${linked ? 'linked' : 'email-matched'} account on ${pkce ? 'PKCE' : 'implicit'} callback`, async () => {
          if (linked) await linkIdentity()
          await db!.query(`update auth.users set ${state.sql} where id = $1`, [userId])
          const beforeUsers = (await db!.query(
            `select id, email, deleted_at::text as deleted_at, banned_until::text as banned_until,
                    last_sign_in_at::text as last_sign_in_at
             from auth.users`,
          )).rows
          const beforeIdentities = (await db!.query(
            `select user_id, provider, provider_id, identity_data::text as identity_data
             from auth.identities`,
          )).rows
          const redirect = await callback(pkce)
          const fragment = new URLSearchParams(redirect.hash.slice(1))
          expect(fragment.get('error')).toBe('access_denied')
          expect(fragment.get('error_code')).toBe(state.code)
          expect(fragment.has('access_token')).toBe(false)
          expect(redirect.searchParams.has('code')).toBe(false)
          await expectNoSession()
          expect((await db!.query(
            `select id, email, deleted_at::text as deleted_at, banned_until::text as banned_until,
                    last_sign_in_at::text as last_sign_in_at
             from auth.users`,
          )).rows).toEqual(beforeUsers)
          expect((await db!.query(
            `select user_id, provider, provider_id, identity_data::text as identity_data
             from auth.identities`,
          )).rows).toEqual(beforeIdentities)
        })
      }
    }
  }

  for (const state of states) {
    test(`rechecks ${state.name} status after callback before PKCE exchange`, async () => {
      const redirect = await callback(true)
      const code = redirect.searchParams.get('code')
      expect(code).toBeString()
      await db!.query(`update auth.users set ${state.sql} where id = $1`, [userId])
      const response = await request('token?grant_type=pkce', { auth_code: code, code_verifier: verifier })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error_code: state.code })
      await expectNoSession()
      const replay = await request('token?grant_type=pkce', { auth_code: code, code_verifier: verifier })
      expect(replay.status).toBe(403)
    })
  }

  for (const pkce of [false, true]) {
    for (const linked of [false, true]) {
      test(`allows eligible ${linked ? 'linked' : 'email-matched'} account with ${pkce ? 'PKCE' : 'implicit'} flow`, async () => {
        if (linked) await linkIdentity()
        const redirect = await callback(pkce)
        let token: unknown = new URLSearchParams(redirect.hash.slice(1)).get('access_token')
        if (pkce) {
          const response = await request('token?grant_type=pkce', {
            auth_code: redirect.searchParams.get('code'), code_verifier: verifier,
          })
          expect(response.status).toBe(200)
          const body: Record<string, unknown> = await response.json()
          token = body.access_token
        }
        if (typeof token !== 'string') throw new Error('Expected OAuth token')
        expect(await verifyJwt(token, secret)).toMatchObject({
          sub: userId, email, amr: [{ method: 'oauth', timestamp: expect.any(Number) }],
        })
        expect((await db!.query('select user_id from auth.refresh_tokens')).rows).toEqual([{ user_id: userId }])
      })
    }
  }

  test('allows an expired ban', async () => {
    await db!.query(`update auth.users set banned_until = now() - interval '1 hour' where id = $1`, [userId])
    const redirect = await callback(false)
    expect(new URLSearchParams(redirect.hash.slice(1)).get('access_token')).toBeString()
  })

  test('still creates a new OAuth user and identity', async () => {
    await db!.query('delete from auth.users where id = $1', [userId])
    const redirect = await callback(false)
    const token = new URLSearchParams(redirect.hash.slice(1)).get('access_token')
    if (!token) throw new Error('Expected OAuth token')
    const claims = await verifyJwt(token, secret)
    expect(claims?.email).toBe(email)
    expect(claims?.sub).not.toBe(userId)
    expect((await db!.query('select user_id from auth.identities')).rows).toEqual([{ user_id: claims?.sub }])
  })

  for (const code of ['user_banned', 'user_not_found'] as const) {
    test(`redirects a final implicit session check rejection for ${code}`, async () => {
      const oauth = new OAuthService(db!, 'http://lite.local', 'http://app.local/callback', {
        google: { clientId: 'test-client', clientSecret: 'test-secret' },
      }, (async (input) => String(input).includes('token')
        ? Response.json({ access_token: 'provider-token' })
        : Response.json({ sub: 'provider-user', email, email_verified: true })) as typeof fetch)
      const start = await oauth.authorize(new URL('http://lite.local/auth/v1/authorize?provider=google'))
      const state = new URL(start.headers.get('location')!).searchParams.get('state')
      const response = await oauth.callback(
        new URL(`http://lite.local/auth/v1/callback?code=test-code&state=${state}`),
        async () => { throw new OAuthAccountIneligibleError(code) },
      )
      expect(response.status).toBe(303)
      const fragment = new URLSearchParams(new URL(response.headers.get('location')!).hash.slice(1))
      expect(fragment.get('error_code')).toBe(code)
      expect(fragment.has('access_token')).toBe(false)
      await expectNoSession()
    })
  }

  test('rejects an account deleted after PKCE callback without a server error', async () => {
    const redirect = await callback(true)
    await db!.query('delete from auth.users where id = $1', [userId])
    const response = await request('token?grant_type=pkce', {
      auth_code: redirect.searchParams.get('code'), code_verifier: verifier,
    })
    expect(response.status).toBe(403)
    await expectNoSession()
  })
})
