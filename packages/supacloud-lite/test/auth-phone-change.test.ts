import { afterEach, describe, expect, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { createLiteBackend, type SupaCloudLiteBackend } from '../src/index.js'

const backends: SupaCloudLiteBackend[] = []

afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.close()))
})

function clientFor(backend: SupaCloudLiteBackend) {
  return createClient('http://local', backend.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: backend.fetch },
  })
}

function smsCode(backend: SupaCloudLiteBackend): string {
  const code = backend.smsInbox?.list()[0]?.code
  expect(code).toMatch(/^\d{6}$/)
  return code!
}

describe('Auth phone change compatibility', () => {
  test('updates a signed-in phone through the official update and verifyOtp contracts', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      authSettings: { smsOtpCooldownSeconds: 0 },
      log: () => {},
    })
    backends.push(backend)
    const admin = createClient('http://local', backend.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: backend.fetch },
    })
    const client = clientFor(backend)

    const created = await admin.auth.admin.createUser({
      email: 'phone-change@example.test',
      password: 'correct-horse-battery-staple',
      email_confirm: true,
      phone: '+14155550120',
      phone_confirm: true,
    })
    expect(created.error).toBeNull()
    const signedIn = await client.auth.signInWithPassword({
      email: 'phone-change@example.test',
      password: 'correct-horse-battery-staple',
    })
    expect(signedIn.error).toBeNull()

    const requested = await client.auth.updateUser({ phone: '+14155550121' })
    expect(requested.error).toBeNull()
    expect(requested.data.user?.phone).toBe('+14155550120')
    expect(requested.data.user?.new_phone).toBe('+14155550121')

    const resent = await client.auth.resend({ type: 'phone_change', phone: '+14155550121' })
    expect(resent.error).toBeNull()
    const code = smsCode(backend)
    const verified = await client.auth.verifyOtp({
      type: 'phone_change',
      phone: '+14155550121',
      token: code,
    })
    expect(verified.error).toBeNull()
    expect(verified.data.user?.phone).toBe('+14155550121')
    expect(verified.data.user?.phone_confirmed_at).toBeString()

    const replayed = await client.auth.verifyOtp({
      type: 'phone_change',
      phone: '+14155550121',
      token: code,
    })
    expect(replayed.error).not.toBeNull()
    expect(replayed.data.session).toBeNull()
    expect((await backend.db.query(
      `select provider, provider_id, identity_data
       from auth.identities where user_id = $1 and provider = 'phone'`,
      [created.data.user!.id],
    )).rows).toEqual([
      expect.objectContaining({ provider: 'phone', provider_id: '+14155550121' }),
    ])
  })

  test('rejects a pending phone change that targets another existing user', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      authSettings: { smsOtpCooldownSeconds: 0 },
      log: () => {},
    })
    backends.push(backend)
    const admin = createClient('http://local', backend.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: backend.fetch },
    })
    const client = clientFor(backend)
    await admin.auth.admin.createUser({
      email: 'first-phone@example.test',
      password: 'correct-horse-battery-staple',
      email_confirm: true,
      phone: '+14155550122',
      phone_confirm: true,
    })
    await admin.auth.admin.createUser({
      email: 'second-phone@example.test',
      password: 'correct-horse-battery-staple',
      email_confirm: true,
      phone: '+14155550123',
      phone_confirm: true,
    })
    expect((await client.auth.signInWithPassword({
      email: 'first-phone@example.test',
      password: 'correct-horse-battery-staple',
    })).error).toBeNull()

    const rejected = await client.auth.updateUser({ phone: '+14155550123' })
    expect(rejected.error?.code).toBe('phone_exists')
    expect(backend.smsInbox?.list()).toHaveLength(0)
  })

  test('synchronizes providers when an email user confirms a phone change', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      authSettings: { smsOtpCooldownSeconds: 0 },
      log: () => {},
    })
    backends.push(backend)
    const admin = createClient('http://local', backend.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: backend.fetch },
    })
    const client = clientFor(backend)

    const created = await admin.auth.admin.createUser({
      email: 'phone-provider-metadata@example.test',
      password: 'correct-horse-battery-staple',
      email_confirm: true,
    })
    expect(created.error).toBeNull()
    expect((await client.auth.signInWithPassword({
      email: 'phone-provider-metadata@example.test',
      password: 'correct-horse-battery-staple',
    })).error).toBeNull()

    expect((await client.auth.updateUser({ phone: '+14155550124' })).error).toBeNull()
    expect((await client.auth.resend({
      type: 'phone_change',
      phone: '+14155550124',
    })).error).toBeNull()
    const verified = await client.auth.verifyOtp({
      type: 'phone_change',
      phone: '+14155550124',
      token: smsCode(backend),
    })
    expect(verified.error).toBeNull()
    expect(verified.data.user?.app_metadata.providers).toEqual(['email', 'phone'])
  })
})
