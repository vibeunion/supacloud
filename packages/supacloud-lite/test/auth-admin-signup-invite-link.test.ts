import { describe, expect, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { createLiteBackend } from '../src/index.js'

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
}

describe('Auth admin signup and invite links', () => {
  test('creates a password-backed signup user and redeems its link', async () => {
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
    const password = 'correct-horse-battery-staple'

    try {
      const generated = await serviceClient.auth.admin.generateLink({
        type: 'signup',
        email: 'admin-signup@example.com',
        password,
        options: { data: { source: 'admin' }, redirectTo: 'http://app.local/confirmed' },
      })
      expect(generated.error).toBeNull()
      expect(generated.data.properties?.verification_type).toBe('signup')
      expect(generated.data.properties?.action_link).toContain('type=signup')
      expect(generated.data.user?.user_metadata).toEqual({ source: 'admin' })
      expect((await backend.db.query<{ email_confirmed_at: string | null; encrypted_password: string | null }>(
        `select email_confirmed_at, encrypted_password from auth.users where email = $1`,
        ['admin-signup@example.com'],
      )).rows[0]).toMatchObject({ email_confirmed_at: null })
      expect((await backend.db.query<{ encrypted_password: string | null }>(
        `select encrypted_password from auth.users where email = $1`,
        ['admin-signup@example.com'],
      )).rows[0].encrypted_password).toMatch(/^\$2[aby]\$[0-9]{2}\$/)

      const emailOtp = generated.data.properties?.email_otp
      if (!emailOtp) throw new Error('generateLink returned no signup OTP')
      const verified = await anonClient.auth.verifyOtp({
        type: 'signup',
        email: 'admin-signup@example.com',
        token: emailOtp,
      })
      expect(verified.error).toBeNull()
      expect(verified.data.session?.access_token).toBeString()

      const signedIn = await anonClient.auth.signInWithPassword({
        email: 'admin-signup@example.com',
        password,
      })
      expect(signedIn.error).toBeNull()
      expect(signedIn.data.user?.email).toBe('admin-signup@example.com')
    } finally {
      await backend.close()
    }
  })

  test('creates an invited user, marks invited_at, and rejects duplicate invites', async () => {
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
      const generated = await serviceClient.auth.admin.generateLink({
        type: 'invite',
        email: 'admin-invite@example.com',
        options: { data: { team: 'platform' } },
      })
      expect(generated.error).toBeNull()
      expect(generated.data.properties?.verification_type).toBe('invite')
      expect(generated.data.user?.user_metadata).toEqual({ team: 'platform' })
      expect((await backend.db.query<{ invited_at: string | null; email_confirmed_at: string | null }>(
        `select invited_at, email_confirmed_at from auth.users where email = $1`,
        ['admin-invite@example.com'],
      )).rows[0]).toMatchObject({ email_confirmed_at: null })
      expect((await backend.db.query<{ invited_at: string | null }>(
        `select invited_at from auth.users where email = $1`,
        ['admin-invite@example.com'],
      )).rows[0].invited_at).toBeTruthy()

      const emailOtp = generated.data.properties?.email_otp
      if (!emailOtp) throw new Error('generateLink returned no invite OTP')
      const verified = await anonClient.auth.verifyOtp({
        type: 'invite',
        email: 'admin-invite@example.com',
        token: emailOtp,
      })
      expect(verified.error).toBeNull()
      expect(verified.data.session?.access_token).toBeString()

      const duplicate = await serviceClient.auth.admin.generateLink({
        type: 'invite',
        email: 'admin-invite@example.com',
      })
      expect(duplicate.error?.code).toBe('email_exists')
      expect(duplicate.data.user).toBeNull()
    } finally {
      await backend.close()
    }
  })
})
