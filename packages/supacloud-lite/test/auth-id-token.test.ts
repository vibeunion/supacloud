import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { AuthHandler } from '../src/runtime/auth/handler.js'
import { InboxMailer } from '../src/runtime/auth/inbox.js'
import { Database } from '../src/runtime/db/database.js'
import { verifyJwt } from '../src/runtime/jwt.js'

describe('OIDC ID token sign-in', () => {
  let db: Database
  let auth: AuthHandler
  let privateKey: CryptoKey
  let jwks: Record<string, unknown>
  const jwtSecret = 'id-token-secret'.repeat(4)

  beforeAll(async () => {
    db = await Database.create()
    const keys = await generateKeyPair('RS256')
    privateKey = keys.privateKey
    const publicJwk = await exportJWK(keys.publicKey)
    jwks = { keys: [{ ...publicJwk, kid: 'id-token-key', alg: 'RS256', use: 'sig' }] }
  })

  beforeEach(async () => {
    await db.exec('delete from auth.identities; delete from auth.refresh_tokens; delete from auth.users;')
    auth = new AuthHandler(db, {
      jwtSecret,
      apiUrl: 'https://lite.example.test',
      siteUrl: 'https://app.example.test',
      jwtExpiry: 3600,
      mailer: new InboxMailer(),
      rateLimiter: null,
      oauthProviders: {
        google: {
          clientId: 'google-client',
          clientSecret: 'unused',
          authorizeUrl: 'https://provider.example.test/authorize',
          tokenUrl: 'https://provider.example.test/token',
          userInfoUrl: 'https://provider.example.test/userinfo',
          idTokenIssuer: 'https://accounts.example.test',
          idTokenJwksUrl: 'https://provider.example.test/.well-known/jwks.json',
        },
      },
      oauthFetch: (async (input) => {
        if (String(input) === 'https://provider.example.test/.well-known/jwks.json') {
          return Response.json(jwks)
        }
        return new Response(null, { status: 404 })
      }) as typeof fetch,
    })
  })

  afterAll(async () => {
    await auth?.stop()
    await db?.close()
  })

  async function idToken(claims: Record<string, unknown> = {}, nonce?: string): Promise<string> {
    return new SignJWT({
      sub: 'oidc-user',
      email: 'oidc@example.test',
      email_verified: true,
      name: 'OIDC User',
      ...claims,
      ...(nonce === undefined ? {} : { nonce }),
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'id-token-key', typ: 'JWT' })
      .setIssuer('https://accounts.example.test')
      .setAudience('google-client')
      .setIssuedAt()
      .setExpirationTime('5 minutes')
      .sign(privateKey)
  }

  async function request(body: Record<string, unknown>): Promise<Response> {
    const url = new URL('https://lite.example.test/auth/v1/token?grant_type=id_token')
    return auth.handle(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), { role: 'anon', claims: null }, url)
  }

  test('verifies the token and creates the provider identity and session', async () => {
    const response = await request({ provider: 'google', id_token: await idToken() })
    expect(response.status).toBe(200)
    const body = await response.json() as { access_token: string; user: { email: string; identities: Array<{ provider: string }> } }
    expect(body.user).toMatchObject({ email: 'oidc@example.test', identities: [{ provider: 'google' }] })
    expect(await verifyJwt(body.access_token, jwtSecret)).toMatchObject({ email: 'oidc@example.test' })
  })

  test('requires a matching nonce when the ID token contains one', async () => {
    const token = await idToken({}, 'expected-nonce')
    expect((await request({ provider: 'google', id_token: token })).status).toBe(400)
    expect((await request({ provider: 'google', id_token: token, nonce: 'wrong-nonce' })).status).toBe(400)
    expect((await request({ provider: 'google', id_token: token, nonce: 'expected-nonce' })).status).toBe(200)
  })

  test('rejects forged, expired, wrong-issuer and wrong-audience tokens', async () => {
    const forged = await new SignJWT({ sub: 'oidc-user' })
      .setProtectedHeader({ alg: 'RS256', kid: 'id-token-key' })
      .setIssuer('https://accounts.example.test')
      .setAudience('google-client')
      .setIssuedAt()
      .setExpirationTime('5 minutes')
      .sign(await generateKeyPair('RS256').then(({ privateKey: key }) => key))
    expect((await request({ provider: 'google', id_token: forged })).status).toBe(400)

    const expired = await new SignJWT({ sub: 'oidc-user', email: 'oidc@example.test', email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'id-token-key' })
      .setIssuer('https://accounts.example.test')
      .setAudience('google-client')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1)
      .sign(privateKey)
    expect((await request({ provider: 'google', id_token: expired })).status).toBe(400)

    const wrongIssuer = await new SignJWT({ sub: 'oidc-user' })
      .setProtectedHeader({ alg: 'RS256', kid: 'id-token-key' })
      .setIssuer('https://wrong.example.test')
      .setAudience('google-client')
      .setIssuedAt()
      .setExpirationTime('5 minutes')
      .sign(privateKey)
    expect((await request({ provider: 'google', id_token: wrongIssuer })).status).toBe(400)

    const wrongAudience = await new SignJWT({ sub: 'oidc-user' })
      .setProtectedHeader({ alg: 'RS256', kid: 'id-token-key' })
      .setIssuer('https://accounts.example.test')
      .setAudience('wrong-client')
      .setIssuedAt()
      .setExpirationTime('5 minutes')
      .sign(privateKey)
    expect((await request({ provider: 'google', id_token: wrongAudience })).status).toBe(400)
  })

  test('validates at_hash when the provider includes it', async () => {
    const accessToken = 'provider-access-token'
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken)))
    const atHash = Buffer.from(digest.subarray(0, digest.length / 2)).toString('base64url')
    const token = await idToken({ at_hash: atHash })
    expect((await request({ provider: 'google', id_token: token, access_token: accessToken })).status).toBe(200)
    expect((await request({ provider: 'google', id_token: token, access_token: 'wrong-access-token' })).status).toBe(400)
  })
})
