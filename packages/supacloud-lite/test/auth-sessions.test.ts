import { describe, expect, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { createLiteBackend } from '../src/index.js'

describe('Auth session limits', () => {
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
