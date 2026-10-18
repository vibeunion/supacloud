import { afterEach, describe, expect, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { createLiteBackend, type SupaCloudLiteBackend } from '../src/index.js'

const backends: SupaCloudLiteBackend[] = []
const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
}

afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.close()))
})

function clientFor(backend: SupaCloudLiteBackend) {
  return createClient('http://local', backend.anonKey, {
    ...clientOptions,
    global: { fetch: backend.fetch },
  })
}

describe('Auth reauthentication compatibility', () => {
  test('sends an email nonce and consumes it exactly once for stale password updates', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      apiUrl: 'http://local',
      authSettings: { requirePasswordReauthentication: true, smsOtpCooldownSeconds: 0 },
      log: () => {},
    })
    backends.push(backend)
    const admin = createClient('http://local', backend.serviceRoleKey, {
      ...clientOptions,
      global: { fetch: backend.fetch },
    })
    const client = clientFor(backend)

    const created = await admin.auth.admin.createUser({
      email: 'reauth-email@example.test',
      password: 'old-password-123',
      email_confirm: true,
    })
    expect(created.error).toBeNull()
    const signedIn = await client.auth.signInWithPassword({
      email: 'reauth-email@example.test',
      password: 'old-password-123',
    })
    expect(signedIn.error).toBeNull()
    await backend.db.query(
      `update auth.refresh_tokens set created_at = now() - interval '2 days' where user_id = $1`,
      [created.data.user!.id],
    )

    const rejected = await client.auth.updateUser({ password: 'new-password-123' })
    expect(rejected.error?.code).toBe('reauthentication_needed')

    const requested = await client.auth.reauthenticate()
    expect(requested.error).toBeNull()
    expect(backend.inbox?.list()).toHaveLength(1)
    expect(backend.inbox?.list()[0]).toMatchObject({
      to: 'reauth-email@example.test',
      subject: 'Your reauthentication code',
    })
    const nonce = backend.inbox?.list()[0]?.code
    expect(nonce).toMatch(/^\d{6}$/)
    if (!nonce) throw new Error('reauthentication email did not include an OTP')

    const updated = await client.auth.updateUser({ password: 'new-password-123', nonce })
    expect(updated.error).toBeNull()
    expect((await client.auth.updateUser({ password: 'another-password-123', nonce })).error?.code)
      .toBe('reauthentication_not_valid')
    expect((await client.auth.signInWithPassword({
      email: 'reauth-email@example.test',
      password: 'new-password-123',
    })).error).toBeNull()
  })

  test('falls back to a confirmed phone when email is unavailable', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      apiUrl: 'http://local',
      authSettings: { requirePasswordReauthentication: true, smsOtpCooldownSeconds: 0 },
      log: () => {},
    })
    backends.push(backend)
    const admin = createClient('http://local', backend.serviceRoleKey, {
      ...clientOptions,
      global: { fetch: backend.fetch },
    })
    const client = clientFor(backend)

    const created = await admin.auth.admin.createUser({
      phone: '+14155550321',
      password: 'old-password-123',
      phone_confirm: true,
    })
    expect(created.error).toBeNull()
    expect((await client.auth.signInWithPassword({
      phone: '+14155550321',
      password: 'old-password-123',
    })).error).toBeNull()
    await backend.db.query(
      `update auth.refresh_tokens set created_at = now() - interval '2 days' where user_id = $1`,
      [created.data.user!.id],
    )

    const requested = await client.auth.reauthenticate()
    expect(requested.error).toBeNull()
    const nonce = backend.smsInbox?.list()[0]?.code
    expect(nonce).toMatch(/^\d{6}$/)
    if (!nonce) throw new Error('reauthentication SMS did not include an OTP')
    expect((await client.auth.updateUser({ password: 'new-password-123', nonce })).error).toBeNull()
  })
})
