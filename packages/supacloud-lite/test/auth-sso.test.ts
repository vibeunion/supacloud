import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'

describe('Auth SSO compatibility', () => {
  let db: Database
  let auth: AuthHandler

  beforeAll(async () => {
    db = await Database.create()
    auth = new AuthHandler(db, {
      jwtSecret: 'sso-auth-secret'.repeat(4),
      apiUrl: 'https://lite.example.test',
      siteUrl: 'https://app.example.test',
      jwtExpiry: 3600,
      mailer: new InboxMailer(),
      rateLimiter: null,
      oauthProviders: {
        acme: {
          clientId: 'acme-client',
          clientSecret: 'acme-secret',
          authorizeUrl: 'https://idp.example.test/authorize',
          tokenUrl: 'https://idp.example.test/token',
          userInfoUrl: 'https://idp.example.test/userinfo',
          ssoDomains: ['acme.example'],
        },
      },
    })
  })

  afterAll(async () => {
    await auth.stop()
    await db.close()
  })

  async function request(body: Record<string, unknown>): Promise<Response> {
    const url = new URL('https://lite.example.test/auth/v1/sso')
    return auth.handle(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), { role: 'anon', claims: null }, url)
  }

  test('resolves a configured provider id and preserves PKCE parameters', async () => {
    const response = await request({
      provider_id: 'acme',
      redirect_to: 'https://app.example.test/callback',
      code_challenge: 'challenge',
      code_challenge_method: 's256',
      skip_http_redirect: true,
    })
    expect(response.status).toBe(200)
    const location = new URL((await response.json() as { url: string }).url)
    expect(location.origin).toBe('https://idp.example.test')
    expect(location.pathname).toBe('/authorize')
    expect(location.searchParams.get('client_id')).toBe('acme-client')
    expect(location.searchParams.get('redirect_uri')).toBe('https://lite.example.test/auth/v1/callback')
    expect((await db.query<{ code_challenge: string; code_challenge_method: string }>(
      'select code_challenge, code_challenge_method from auth.flow_state',
    )).rows).toEqual([{ code_challenge: 'challenge', code_challenge_method: 's256' }])
  })

  test('resolves a provider by configured email domain', async () => {
    const response = await request({
      domain: 'ACME.EXAMPLE',
      skip_http_redirect: true,
    })
    expect(response.status).toBe(200)
    expect(new URL((await response.json() as { url: string }).url).searchParams.get('client_id')).toBe('acme-client')
  })

  test('rejects unknown SSO providers without redirecting', async () => {
    const response = await request({ provider_id: 'missing', skip_http_redirect: true })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error_code: 'sso_provider_not_found' })
  })
})
