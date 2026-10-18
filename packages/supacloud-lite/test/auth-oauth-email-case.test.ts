import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'
import { verifyJwt } from '../src/runtime/jwt.js'

describe('Auth OAuth email casing', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  let userId: string
  const storedEmail = 'MixedCase@Example.test'
  const jwtSecret = 'oauth-email-case-secret'.repeat(2)

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.flow_state; delete from auth.users;')
    userId = (await db!.query<{ id: string }>(
      `insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id`,
      [storedEmail],
    )).rows[0].id
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
        if (url.pathname === '/userinfo') {
          return Response.json({ sub: 'provider-user', email: storedEmail.toLowerCase(), email_verified: true })
        }
        return new Response(null, { status: 404 })
      }) as typeof fetch,
    })
  })
  afterEach(async () => { await auth?.stop() })
  afterAll(async () => { await db?.close() })

  test('links a verified OAuth email to an imported mixed-case account', async () => {
    const authorizeUrl = new URL('http://lite.local/auth/v1/authorize?provider=google')
    const authorized = await auth!.handle(new Request(authorizeUrl), { role: 'anon', claims: null }, authorizeUrl)
    const state = new URL(authorized.headers.get('location')!).searchParams.get('state')!
    const callbackUrl = new URL(`http://lite.local/auth/v1/callback?code=provider-code&state=${encodeURIComponent(state)}`)
    const callback = await auth!.handle(new Request(callbackUrl), { role: 'anon', claims: null }, callbackUrl)

    expect(callback.status).toBe(303)
    const redirect = new URL(callback.headers.get('location')!)
    const accessToken = new URLSearchParams(redirect.hash.slice(1)).get('access_token')
    expect(accessToken).toBeString()
    expect(await verifyJwt(accessToken!, jwtSecret)).toMatchObject({ sub: userId, email: storedEmail })
    expect((await db!.query('select id from auth.users')).rows).toHaveLength(1)
    expect((await db!.query(
      `select user_id, provider, provider_id from auth.identities`,
    )).rows).toEqual([{ user_id: userId, provider: 'google', provider_id: 'provider-user' }])
  })
})
