import { describe, expect, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { createLiteBackend } from '../src/index.js'

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
}

describe('Auth admin invite compatibility', () => {
  test('invites through the dedicated endpoint and sends an invitation email', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      apiUrl: 'http://local',
      log: () => {},
    })
    const serviceClient = createClient('http://local', backend.serviceRoleKey, {
      ...clientOptions,
      global: { fetch: backend.fetch },
    })
    const anonClient = createClient('http://local', backend.anonKey, {
      ...clientOptions,
      global: { fetch: backend.fetch },
    })

    try {
      const invited = await serviceClient.auth.admin.inviteUserByEmail('dedicated-invite@example.com', {
        data: { source: 'invite-endpoint' },
        redirectTo: 'http://app.local/invited',
      })
      expect(invited.error).toBeNull()
      expect(invited.data.user?.email).toBe('dedicated-invite@example.com')
      expect(invited.data.user?.user_metadata).toEqual({ source: 'invite-endpoint' })
      expect(backend.inbox?.list()).toHaveLength(1)
      expect(backend.inbox?.list()[0]).toMatchObject({
        to: 'dedicated-invite@example.com',
        subject: 'You have been invited',
      })
      const link = backend.inbox?.list()[0]?.link
      if (!link) throw new Error('invite endpoint did not send an invitation link')
      expect(new URL(link).searchParams.get('redirect_to')).toBe('http://app.local/invited')

      const token = new URL(link).searchParams.get('token')
      if (!token) throw new Error('invitation email did not include a token')
      const verified = await anonClient.auth.verifyOtp({
        type: 'invite',
        token_hash: token,
      })
      expect(verified.error).toBeNull()
      expect(verified.data.user?.email).toBe('dedicated-invite@example.com')
    } finally {
      await backend.close()
    }
  })

  test('requires the service role for the dedicated invite endpoint', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      apiUrl: 'http://local',
      log: () => {},
    })
    try {
      const response = await backend.fetch('http://local/auth/v1/invite', {
        method: 'POST',
        headers: {
          apikey: backend.anonKey,
          authorization: `Bearer ${backend.anonKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: 'denied-invite@example.com' }),
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error_code: 'insufficient_permissions' })
    } finally {
      await backend.close()
    }
  })
})
