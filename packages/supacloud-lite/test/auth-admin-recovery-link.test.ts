import { describe, expect, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { createLiteBackend } from '../src/index.js'

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
}

describe('Auth admin recovery link compatibility', () => {
  test('generates and redeems a recovery link for an existing user', async () => {
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
      const created = await serviceClient.auth.admin.createUser({
        email: 'admin-recovery@example.com',
        email_confirm: true,
      })
      expect(created.error).toBeNull()

      const generated = await serviceClient.auth.admin.generateLink({
        type: 'recovery',
        email: 'admin-recovery@example.com',
      })
      expect(generated.error).toBeNull()
      expect(generated.data.user?.id).toBe(created.data.user?.id)
      expect(generated.data.properties?.verification_type).toBe('recovery')
      expect(generated.data.properties?.action_link).toContain('type=recovery')
      const emailOtp = generated.data.properties?.email_otp
      expect(emailOtp).toMatch(/^\d{6}$/)
      if (!emailOtp) throw new Error('generateLink returned no recovery OTP')

      const verified = await anonClient.auth.verifyOtp({
        type: 'recovery',
        email: 'admin-recovery@example.com',
        token: emailOtp,
      })
      expect(verified.error).toBeNull()
      expect(verified.data.user?.id).toBe(created.data.user?.id)
      expect(verified.data.session?.access_token).toBeString()
    } finally {
      await backend.close()
    }
  })

  test('does not create a user for an unknown recovery target', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      log: () => {},
    })
    const serviceClient = createClient('http://local', backend.serviceRoleKey, {
      ...clientOptions,
      global: { fetch: backend.fetch },
    })
    try {
      const generated = await serviceClient.auth.admin.generateLink({
        type: 'recovery',
        email: 'unknown-admin-recovery@example.com',
      })
      expect(generated.error?.code).toBe('user_not_found')
      expect(generated.data.user).toBeNull()
      expect((await backend.db.query('select count(*)::int as count from auth.users')).rows).toEqual([{ count: 0 }])
    } finally {
      await backend.close()
    }
  })
})
