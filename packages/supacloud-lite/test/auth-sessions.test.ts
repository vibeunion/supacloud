import { describe, expect, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { createLiteBackend, type SupaCloudLiteBackend } from '../src/index.js'

describe('Auth session limits', () => {
  test('exposes Auth health without requiring a project API key', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      log: () => {},
    })
    try {
      const response = await backend.fetch('http://local/auth/v1/health')
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        name: 'supacloud-lite-auth',
        description: 'GoTrue-compatible auth',
      })
    } finally {
      await backend.close()
    }
  })

  test('keeps project API key enforcement on non-public Auth endpoints', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      log: () => {},
    })
    try {
      const response = await backend.fetch('http://local/auth/v1/token?grant_type=password', {
        method: 'POST',
      })
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ message: 'No API key found in request' })
    } finally {
      await backend.close()
    }
  })

  test('keeps Auth in-process and can disable only its public routes', async () => {
    const backend = await createLiteBackend({
      authEnabled: false,
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      log: () => {},
    })
    try {
      const response = await backend.fetch('http://local/auth/v1/health')
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ message: 'Auth service is disabled' })
    } finally {
      await backend.close()
    }
  })

  test('does not reset the absolute session timebox during refresh', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      sessionTimeboxSeconds: 1,
      log: () => {},
    })
    try {
      const session = await signUp(backend.fetch, backend.anonKey, 'timebox@example.com')
      await Bun.sleep(1_100)
      expect((await refresh(backend.fetch, backend.anonKey, session.refresh_token)).status).toBe(400)
    } finally {
      await backend.close()
    }
  })

  test('rejects refresh after the configured inactivity timeout', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      sessionInactivitySeconds: 1,
      log: () => {},
    })
    try {
      const session = await signUp(backend.fetch, backend.anonKey, 'inactive@example.com')
      await Bun.sleep(1_100)
      expect((await refresh(backend.fetch, backend.anonKey, session.refresh_token)).status).toBe(400)
    } finally {
      await backend.close()
    }
  })

  test('allows only one concurrent refresh of the same token', async () => {
    const backend = await createLiteBackend({ jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), log: () => {} })
    try {
      const session = await signUp(backend.fetch, backend.anonKey, 'concurrent-refresh@example.com')
      const responses = await Promise.all([
        refresh(backend.fetch, backend.anonKey, session.refresh_token),
        refresh(backend.fetch, backend.anonKey, session.refresh_token),
      ])
      expect(responses.map((response) => response.status).sort()).toEqual([200, 400])
      const rejected = responses.find((response) => response.status === 400)!
      expect(await rejected.json()).toEqual({
        code: 400,
        error_code: 'refresh_token_not_found',
        msg: 'Invalid Refresh Token: Refresh Token Not Found',
      })
      const tokens = await backend.db.query<{ parent: string | null; revoked: boolean }>(
        `select parent, revoked from auth.refresh_tokens where token = $1 or parent = $1 order by id`,
        [session.refresh_token]
      )
      expect(tokens.rows).toHaveLength(2)
      const children = tokens.rows.filter((token) => token.parent === session.refresh_token)
      expect(children).toHaveLength(1)
      expect(tokens.rows.find((token) => token.parent === null)?.revoked).toBe(true)
      expect(children[0]?.revoked).toBe(false)
    } finally {
      await backend.close()
    }
  })
})

describe('Auth PKCE code exchange', () => {
  test('allows only one concurrent exchange of the same code', async () => {
    const backend = await createLiteBackend({ jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), log: () => {} })
    try {
      const session = await signUp(backend.fetch, backend.anonKey, 'concurrent-pkce@example.com')
      const verifier = 'valid-pkce-verifier'
      const authCode = 'single-use-auth-code'
      await seedPkceFlow(backend, session.user.id, authCode, await pkceChallenge(verifier))
      const responses = await Promise.all([
        exchangePkce(backend.fetch, backend.anonKey, authCode, verifier),
        exchangePkce(backend.fetch, backend.anonKey, authCode, verifier),
      ])
      expect(responses.map((response) => response.status).sort()).toEqual([200, 403])
      const rejected = responses.find((response) => response.status === 403)!
      expect(await rejected.json()).toMatchObject({ error_code: 'flow_state_not_found' })
    } finally {
      await backend.close()
    }
  })

  test('rejects an incorrect verifier', async () => {
    const backend = await createLiteBackend({ jwtSecret: 'x'.repeat(64), vaultKey: 'y'.repeat(64), log: () => {} })
    try {
      const session = await signUp(backend.fetch, backend.anonKey, 'invalid-pkce@example.com')
      const authCode = 'invalid-verifier-auth-code'
      await seedPkceFlow(backend, session.user.id, authCode, await pkceChallenge('correct-verifier'))
      const response = await exchangePkce(backend.fetch, backend.anonKey, authCode, 'incorrect-verifier')
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error_code: 'flow_state_not_found' })
    } finally {
      await backend.close()
    }
  })
})

async function signUp(fetchImpl: typeof fetch, anonKey: string, email: string) {
  const client = createClient('http://local', anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchImpl },
  })
  const result = await client.auth.signUp({ email, password: 'correct-horse-battery-staple' })
  expect(result.error).toBeNull()
  expect(result.data.session).not.toBeNull()
  return result.data.session!
}

function refresh(fetchImpl: typeof fetch, anonKey: string, refreshToken: string): Promise<Response> {
  return fetchImpl('http://local/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    headers: { apikey: anonKey, 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
}

function exchangePkce(
  fetchImpl: typeof fetch,
  anonKey: string,
  authCode: string,
  verifier: string
): Promise<Response> {
  return fetchImpl('http://local/auth/v1/token?grant_type=pkce', {
    method: 'POST',
    headers: { apikey: anonKey, 'content-type': 'application/json' },
    body: JSON.stringify({ auth_code: authCode, code_verifier: verifier }),
  })
}

async function seedPkceFlow(
  backend: SupaCloudLiteBackend,
  userId: string,
  authCode: string,
  challenge: string
): Promise<void> {
  await backend.db.query(
    `insert into auth.flow_state
       (provider, provider_state, redirect_to, code_challenge, code_challenge_method, auth_code, user_id, expires_at)
     values ('test', $1, 'http://local', $2, 's256', $3, $4, now() + interval '5 minutes')`,
    [crypto.randomUUID(), challenge, authCode, userId]
  )
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return Buffer.from(digest).toString('base64url')
}
