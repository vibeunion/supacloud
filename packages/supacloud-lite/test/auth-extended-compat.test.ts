import { describe, expect, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { createLiteBackend, type SupaCloudLiteBackend } from '../src/index.js'
import { totpNow } from '../src/runtime/auth/totp.js'

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
}

describe('Auth extended GoTrue compatibility', () => {
  test('does not reveal whether a recovery email is registered', async () => {
    const backend = await backendForTest()
    const client = anonClient(backend)
    try {
      const created = await client.auth.signUp({ email: 'recovery-known@example.test', password: 'correct-horse-battery-staple' })
      expect(created.error).toBeNull()

      const known = await backend.fetch('http://local/auth/v1/recover', {
        method: 'POST', headers: apiHeaders(backend.anonKey), body: JSON.stringify({ email: 'recovery-known@example.test' }),
      })
      const unknown = await backend.fetch('http://local/auth/v1/recover', {
        method: 'POST', headers: apiHeaders(backend.anonKey), body: JSON.stringify({ email: 'recovery-unknown@example.test' }),
      })

      expect(known.status).toBe(200)
      expect(unknown.status).toBe(200)
      expect(await known.json()).toEqual({})
      expect(await unknown.json()).toEqual({})
      expect(backend.inbox?.list().map((message) => message.to)).toEqual(['recovery-known@example.test'])
    } finally {
      await backend.close()
    }
  })

  test('accepts OAuth form_post callbacks and records OAuth AMR for implicit and PKCE sessions', async () => {
    const backend = await backendForTest({
      siteUrl: 'http://app.local/callback',
      oauthProviders: {
        google: {
          clientId: 'client-id', clientSecret: 'client-secret',
          authorizeUrl: 'http://provider.local/authorize', tokenUrl: 'http://provider.local/token',
          userInfoUrl: 'http://provider.local/userinfo',
        },
      },
      oauthFetch: (async (input) => {
        const url = new URL(String(input))
        if (url.pathname === '/token') return Response.json({ access_token: 'provider-token' })
        if (url.pathname === '/userinfo') {
          return Response.json({ sub: 'provider-user', email: 'oauth@example.test', email_verified: true, name: 'OAuth User' })
        }
        return new Response('not found', { status: 404 })
      }) as typeof fetch,
    })
    try {
      const implicitAuthorize = await authorize(backend, { provider: 'google', redirect_to: 'http://app.local/callback' })
      const implicitState = new URL(implicitAuthorize.headers.get('location')!).searchParams.get('state')!
      const implicitCallback = await backend.fetch('http://local/auth/v1/callback', {
        method: 'POST',
        headers: { ...apiHeaders(backend.anonKey), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: 'provider-code', state: implicitState }),
      })
      expect(implicitCallback.status).toBe(303)
      const implicitLocation = new URL(implicitCallback.headers.get('location')!)
      const implicitClaims = jwtPayload(new URLSearchParams(implicitLocation.hash.slice(1)).get('access_token')!)
      expect(implicitClaims.amr).toEqual([{ method: 'oauth', timestamp: expect.any(Number) }])

      const verifier = 'oauth-pkce-verifier'
      const pkceAuthorize = await authorize(backend, {
        provider: 'google', redirect_to: 'http://app.local/callback',
        code_challenge: await pkceChallenge(verifier), code_challenge_method: 's256',
      })
      const pkceState = new URL(pkceAuthorize.headers.get('location')!).searchParams.get('state')!
      const pkceCallback = await backend.fetch(`http://local/auth/v1/callback?code=provider-code&state=${pkceState}`, {
        headers: apiHeaders(backend.anonKey),
      })
      const authCode = new URL(pkceCallback.headers.get('location')!).searchParams.get('code')!
      const exchange = await backend.fetch('http://local/auth/v1/token?grant_type=pkce', {
        method: 'POST', headers: apiHeaders(backend.anonKey),
        body: JSON.stringify({ auth_code: authCode, code_verifier: verifier }),
      })
      expect(exchange.status).toBe(200)
      const pkceClaims = jwtPayload((await exchange.json()).access_token)
      expect(pkceClaims.amr).toEqual([{ method: 'oauth', timestamp: expect.any(Number) }])
    } finally {
      await backend.close()
    }
  })

  test('allows only one concurrent verification of a TOTP challenge', async () => {
    const backend = await backendForTest()
    const client = anonClient(backend)
    try {
      const signedUp = await client.auth.signUp({ email: 'mfa-race@example.test', password: 'correct-horse-battery-staple' })
      const accessToken = signedUp.data.session?.access_token
      expect(accessToken).toBeString()
      const headers = userHeaders(backend.anonKey, accessToken!)
      const enrolledResponse = await backend.fetch('http://local/auth/v1/factors', {
        method: 'POST', headers, body: JSON.stringify({ factor_type: 'totp', friendly_name: 'race' }),
      })
      const enrolled = await enrolledResponse.json()
      const challengeResponse = await backend.fetch(`http://local/auth/v1/factors/${enrolled.id}/challenge`, {
        method: 'POST', headers, body: '{}',
      })
      const challenge = await challengeResponse.json()
      const body = JSON.stringify({ challenge_id: challenge.id, code: await totpNow(enrolled.totp.secret) })
      const responses = await Promise.all([
        backend.fetch(`http://local/auth/v1/factors/${enrolled.id}/verify`, { method: 'POST', headers, body }),
        backend.fetch(`http://local/auth/v1/factors/${enrolled.id}/verify`, { method: 'POST', headers, body }),
      ])
      expect(responses.map((response) => response.status).sort()).toEqual([200, 422])
      expect(await responses.find((response) => response.status === 422)!.json()).toMatchObject({
        error_code: 'mfa_verification_failed',
      })
    } finally {
      await backend.close()
    }
  })

  test('supports admin factor list/delete and returns email identities for admin-created users', async () => {
    const backend = await backendForTest()
    const admin = serviceClient(backend)
    const userClient = anonClient(backend)
    try {
      const created = await admin.auth.admin.createUser({
        email: 'admin-created@example.test', password: 'correct-horse-battery-staple', email_confirm: true,
      })
      expect(created.error).toBeNull()
      expect(created.data.user?.identities).toHaveLength(1)
      expect(created.data.user?.identities?.[0]).toMatchObject({ provider: 'email' })
      const signedIn = await userClient.auth.signInWithPassword({
        email: 'admin-created@example.test', password: 'correct-horse-battery-staple',
      })
      expect(signedIn.error).toBeNull()
      const enrolled = await userClient.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'admin-removal' })
      expect(enrolled.error).toBeNull()
      const userId = created.data.user!.id
      const factorId = enrolled.data!.id

      const listed = await admin.auth.admin.mfa.listFactors({ userId })
      expect(listed.error).toBeNull()
      expect(listed.data?.factors).toEqual([expect.objectContaining({ id: factorId, status: 'unverified' })])
      const deleted = await admin.auth.admin.mfa.deleteFactor({ userId, id: factorId })
      expect(deleted.error).toBeNull()
      const listedAfter = await admin.auth.admin.mfa.listFactors({ userId })
      expect(listedAfter.data?.factors).toEqual([])
    } finally {
      await backend.close()
    }
  })

  test('keeps the email identity and refreshed JWT synchronized after updateUser', async () => {
    const backend = await backendForTest()
    const client = anonClient(backend)
    try {
      const signedUp = await client.auth.signUp({ email: 'before-update@example.test', password: 'correct-horse-battery-staple' })
      expect(signedUp.error).toBeNull()
      const updated = await client.auth.updateUser({ email: 'after-update@example.test', data: { updated: true } })
      expect(updated.error).toBeNull()
      expect(updated.data.user?.identities?.[0]?.identity_data?.email).toBe('after-update@example.test')

      const refreshed = await client.auth.refreshSession()
      expect(refreshed.error).toBeNull()
      expect(jwtPayload(refreshed.data.session!.access_token).email).toBe('after-update@example.test')
      expect(refreshed.data.user?.identities?.[0]?.identity_data?.email).toBe('after-update@example.test')
    } finally {
      await backend.close()
    }
  })
})

function backendForTest(overrides: Parameters<typeof createLiteBackend>[0] = {}) {
  return createLiteBackend({
    jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), apiUrl: 'http://local', log: () => {}, ...overrides,
  })
}

function anonClient(backend: SupaCloudLiteBackend) {
  return createClient('http://local', backend.anonKey, { ...clientOptions, global: { fetch: backend.fetch } })
}

function serviceClient(backend: SupaCloudLiteBackend) {
  return createClient('http://local', backend.serviceRoleKey, { ...clientOptions, global: { fetch: backend.fetch } })
}

function apiHeaders(apiKey: string): Record<string, string> {
  return { apikey: apiKey, 'content-type': 'application/json' }
}

function userHeaders(apiKey: string, accessToken: string): Record<string, string> {
  return { ...apiHeaders(apiKey), authorization: `Bearer ${accessToken}` }
}

function authorize(backend: SupaCloudLiteBackend, parameters: Record<string, string>) {
  return backend.fetch(`http://local/auth/v1/authorize?${new URLSearchParams(parameters)}`, {
    headers: apiHeaders(backend.anonKey),
  })
}

function jwtPayload(token: string): Record<string, any> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return Buffer.from(digest).toString('base64url')
}
