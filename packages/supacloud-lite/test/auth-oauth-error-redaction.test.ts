import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'

describe('Auth OAuth error responses', () => {
  let db: Database | undefined
  let auth: AuthHandler | undefined
  const jwtSecret = 'oauth-error-redaction-secret'.repeat(2)

  beforeAll(async () => { db = await Database.create() }, 60_000)
  afterEach(async () => { await auth?.stop() })
  afterAll(async () => { await db?.close() })

  test('does not redirect the provider exception message to the browser', async () => {
    auth = new AuthHandler(db!, {
      jwtSecret,
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
      oauthFetch: (async () => {
        throw new Error('provider credentials must remain private')
      }) as unknown as typeof fetch,
    })

    const authorizeUrl = new URL('http://lite.local/auth/v1/authorize?provider=google')
    const authorized = await auth.handle(new Request(authorizeUrl), { role: 'anon', claims: null }, authorizeUrl)
    const state = new URL(authorized.headers.get('location')!).searchParams.get('state')!
    const callbackUrl = new URL(`http://lite.local/auth/v1/callback?code=provider-code&state=${encodeURIComponent(state)}`)
    const callback = await auth.handle(new Request(callbackUrl), { role: 'anon', claims: null }, callbackUrl)
    const fragment = new URLSearchParams(new URL(callback.headers.get('location')!).hash.slice(1))

    expect(callback.status).toBe(303)
    expect(fragment.get('error')).toBe('server_error')
    expect(fragment.get('error_description')).toBe('OAuth provider request failed')
    expect(fragment.toString()).not.toContain('provider credentials must remain private')
  })
})
