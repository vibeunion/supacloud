import { describe, expect, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { createLiteBackend } from '../src/index.js'

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
}

describe('Auth admin link compatibility', () => {
  test('generates a magic link and verifies its token hash exactly once', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      apiUrl: 'http://local',
      siteUrl: 'http://app.local/auth/callback',
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
        type: 'magiclink',
        email: 'link@example.com',
      })
      expect(generated.error).toBeNull()
      expect(generated.data.user?.email).toBe('link@example.com')
      const properties = generated.data.properties
      expect(properties?.verification_type).toBe('magiclink')
      expect(properties?.redirect_to).toBe('http://app.local/auth/callback')
      expect(properties?.action_link).toContain('/auth/v1/verify?')
      expect(properties?.email_otp).toMatch(/^\d{6}$/)
      expect(properties?.hashed_token).toMatch(/^[0-9a-f]{64}$/)
      if (!properties) throw new Error('generateLink returned no properties')

      const regenerated = await serviceClient.auth.admin.generateLink({
        type: 'magiclink',
        email: 'link@example.com',
      })
      expect(regenerated.error).toBeNull()
      expect(regenerated.data.user?.id).toBe(generated.data.user?.id)
      expect(regenerated.data.properties?.hashed_token).not.toBe(properties.hashed_token)
      const regeneratedToken = regenerated.data.properties?.hashed_token
      if (!regeneratedToken) throw new Error('regenerated link returned no token hash')

      const superseded = await anonClient.auth.verifyOtp({
        type: 'magiclink',
        token_hash: properties.hashed_token,
      })
      expect(superseded.error).not.toBeNull()

      const verified = await anonClient.auth.verifyOtp({
        type: 'magiclink',
        token_hash: regeneratedToken,
      })
      expect(verified.error).toBeNull()
      expect(verified.data.user?.id).toBe(generated.data.user?.id)
      expect(verified.data.session?.access_token).toBeString()

      const replayed = await anonClient.auth.verifyOtp({
        type: 'magiclink',
        token_hash: regeneratedToken,
      })
      expect(replayed.error).not.toBeNull()
      expect(replayed.data.session).toBeNull()

      const otpLink = await serviceClient.auth.admin.generateLink({
        type: 'magiclink',
        email: 'link@example.com',
      })
      expect(otpLink.error).toBeNull()
      const emailOtp = otpLink.data.properties?.email_otp
      if (!emailOtp) throw new Error('generateLink returned no email OTP')
      const otpVerified = await anonClient.auth.verifyOtp({
        type: 'email',
        email: 'link@example.com',
        token: emailOtp,
      })
      expect(otpVerified.error).toBeNull()
      expect(otpVerified.data.user?.id).toBe(generated.data.user?.id)
    } finally {
      await backend.close()
    }
  })

  test('redeems only one credential from a generated link under concurrency', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      apiUrl: 'http://local',
      authRateLimits: { verify: { limit: 100, windowMs: 60_000 } },
      log: () => {},
    })
    const serviceClient = createClient('http://local', backend.serviceRoleKey, {
      ...clientOptions,
      global: { fetch: backend.fetch },
    })
    const firstAnonClient = createClient('http://local', backend.anonKey, {
      ...clientOptions,
      global: { fetch: backend.fetch },
    })
    const secondAnonClient = createClient('http://local', backend.anonKey, {
      ...clientOptions,
      global: { fetch: backend.fetch },
    })

    try {
      for (let round = 0; round < 20; round += 1) {
        const email = `concurrent-link-${round}@example.com`
        const generated = await serviceClient.auth.admin.generateLink({ type: 'magiclink', email })
        const properties = generated.data.properties
        if (!properties) throw new Error('generateLink returned no properties')

        const redemptions = await Promise.all([
          firstAnonClient.auth.verifyOtp({ type: 'magiclink', token_hash: properties.hashed_token }),
          secondAnonClient.auth.verifyOtp({ type: 'email', email, token: properties.email_otp }),
        ])
        expect(redemptions.filter((redemption) => redemption.error === null)).toHaveLength(1)
        expect(redemptions.filter((redemption) => redemption.error?.code === 'otp_expired')).toHaveLength(1)

        const sessions = await backend.db.query<{ count: number }>(
          `select count(*)::int as count from auth.refresh_tokens rt
           join auth.users u on u.id = rt.user_id where u.email = $1`,
          [email]
        )
        expect(sessions.rows).toEqual([{ count: 1 }])
      }
    } finally {
      await backend.close()
    }
  })

  test('requires service role and validates link requests', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      log: () => {},
    })
    try {
      const unauthorized = await backend.fetch('http://local/auth/v1/admin/generate_link', {
        method: 'POST',
        headers: {
          apikey: backend.anonKey,
          authorization: `Bearer ${backend.anonKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ type: 'magiclink', email: 'denied@example.com' }),
      })
      expect(unauthorized.status).toBe(403)

      const headers = {
        apikey: backend.serviceRoleKey,
        authorization: `Bearer ${backend.serviceRoleKey}`,
        'content-type': 'application/json',
      }
      const supported = await backend.fetch('http://local/auth/v1/admin/generate_link', {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'email_change_current', email: 'unsupported@example.com' }),
      })
      expect(supported.status).toBe(400)
      expect(await supported.json()).toMatchObject({ error_code: 'validation_failed' })

      const missingEmail = await backend.fetch('http://local/auth/v1/admin/generate_link', {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'magiclink' }),
      })
      expect(missingEmail.status).toBe(400)
      expect(await missingEmail.json()).toMatchObject({ error_code: 'validation_failed' })
    } finally {
      await backend.close()
    }
  })

  test('supports secure email-change current and new links with OTP and token hashes', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      apiUrl: 'http://local',
      siteUrl: 'http://app.local',
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
        email: 'current@example.com',
        password: 'correct-horse-battery-staple',
        email_confirm: true,
      })
      expect(created.error).toBeNull()

      const current = await serviceClient.auth.admin.generateLink({
        type: 'email_change_current',
        email: 'current@example.com',
        newEmail: 'new@example.com',
      })
      expect(current.error).toBeNull()
      expect(current.data.properties?.verification_type).toBe('email_change_current')
      expect(new URL(current.data.properties!.action_link).searchParams.get('type')).toBe('email_change')

      const next = await serviceClient.auth.admin.generateLink({
        type: 'email_change_new',
        email: 'current@example.com',
        newEmail: 'new@example.com',
      })
      expect(next.error).toBeNull()
      expect(next.data.properties?.verification_type).toBe('email_change_new')

      const newConfirmed = await anonClient.auth.verifyOtp({
        type: 'email_change',
        email: 'new@example.com',
        token: next.data.properties!.email_otp,
      })
      expect(newConfirmed.error).toBeNull()
      expect(newConfirmed.data.session).toBeNull()

      const changed = await anonClient.auth.verifyOtp({
        type: 'email_change',
        token_hash: current.data.properties!.hashed_token,
      })
      expect(changed.error).toBeNull()
      expect(changed.data.user?.email).toBe('new@example.com')

      const replayed = await anonClient.auth.verifyOtp({
        type: 'email_change',
        token_hash: next.data.properties!.hashed_token,
      })
      expect(replayed.error).not.toBeNull()
      expect(replayed.data.session).toBeNull()
    } finally {
      await backend.close()
    }
  })
})
