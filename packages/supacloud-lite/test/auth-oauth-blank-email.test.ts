import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'

describe('Auth OAuth blank email handling', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined

  beforeAll(async () => { db = await Database.create() }, 60_000)
  beforeEach(async () => {
    await db!.exec('delete from auth.flow_state; delete from auth.users;')
    auth = new AuthHandler(db!, {
      jwtSecret: 'oauth-blank-email-secret'.repeat(2),
      apiUrl: 'http://lite.local',
      siteUrl: 'http://app.local',
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
          return Response.json({ sub: 'provider-user', email: '   ', email_verified: true })
        }
        return new Response(null, { status: 404 })
      }) as typeof fetch,
    })
  })
  afterEach(async () => { await auth?.stop() })
  afterAll(async () => { await db?.close() })

  test('does not persist a blank provider email', async () => {
    const authorizeUrl = new URL('http://lite.local/auth/v1/authorize?provider=google')
    const authorized = await auth!.handle(new Request(authorizeUrl), { role: 'anon', claims: null }, authorizeUrl)
    const state = new URL(authorized.headers.get('location')!).searchParams.get('state')!
    const callbackUrl = new URL(`http://lite.local/auth/v1/callback?code=provider-code&state=${encodeURIComponent(state)}`)
    const callback = await auth!.handle(new Request(callbackUrl), { role: 'anon', claims: null }, callbackUrl)

    expect(callback.status).toBe(303)
    expect((await db!.query<{ email: string | null }>('select email from auth.users')).rows)
      .toEqual([{ email: null }])
  })
})
