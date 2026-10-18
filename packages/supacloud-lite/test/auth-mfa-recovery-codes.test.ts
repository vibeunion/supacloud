import { afterEach, describe, expect, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { createLiteBackend, type SupaCloudLiteBackend } from '../src/index.js'
import { totpNow } from '../src/runtime/auth/totp.js'

const backends: SupaCloudLiteBackend[] = []
const clientOptions = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
    experimental: { recoveryCodes: true },
  },
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

function jwtPayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>
}

describe('Auth MFA recovery codes compatibility', () => {
  test('generates, verifies, rotates, and removes recovery codes through supabase-js', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      apiUrl: 'http://local',
      authSettings: {
        recoveryCodesCount: 3,
        recoveryCodesMaxVerifyAttempts: 2,
      },
      log: () => {},
    })
    backends.push(backend)
    const client = clientFor(backend)
    const secondClient = clientFor(backend)

    const signedUp = await client.auth.signUp({
      email: 'mfa-recovery@example.test',
      password: 'correct-horse-battery-staple',
    })
    expect(signedUp.error).toBeNull()
    expect((await client.auth.mfa.recoveryCodes.generate()).error?.code).toBe('insufficient_aal')

    const enrolled = await client.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'authenticator',
    })
    expect(enrolled.error).toBeNull()
    const challenge = await client.auth.mfa.challenge({ factorId: enrolled.data!.id })
    expect(challenge.error).toBeNull()
    const verified = await client.auth.mfa.verify({
      factorId: enrolled.data!.id,
      challengeId: challenge.data!.id,
      code: await totpNow(enrolled.data!.totp.secret),
    })
    expect(verified.error).toBeNull()

    const generated = await client.auth.mfa.recoveryCodes.generate({ friendlyName: 'backup' })
    expect(generated.error).toBeNull()
    expect(generated.data).toMatchObject({
      type: 'recovery_code',
      friendly_name: 'backup',
      total: 3,
    })
    expect(generated.data?.codes).toHaveLength(3)
    expect(generated.data?.codes.every((code) => /^[a-z2-7]{16}$/.test(code))).toBe(true)

    const status = await client.auth.mfa.recoveryCodes.getStatus()
    expect(status.error).toBeNull()
    expect(status.data).toMatchObject({ total: 3, remaining: 3, type: 'recovery_code' })
    expect((await client.auth.mfa.recoveryCodes.generate()).error?.code).toBe('mfa_verified_factor_exists')

    expect((await secondClient.auth.signInWithPassword({
      email: 'mfa-recovery@example.test',
      password: 'correct-horse-battery-staple',
    })).error).toBeNull()
    const firstCode = generated.data!.codes[0]
    const verifiedRecovery = await secondClient.auth.mfa.recoveryCodes.verify({
      code: `${firstCode.slice(0, 4).toUpperCase()}-${firstCode.slice(4)}`,
    })
    expect(verifiedRecovery.error).toBeNull()
    expect(jwtPayload(verifiedRecovery.data!.access_token)).toMatchObject({
      aal: 'aal2',
      amr: [
        { method: 'password', timestamp: expect.any(Number) },
        { method: 'mfa/recovery_code', timestamp: expect.any(Number) },
      ],
    })
    expect((await secondClient.auth.mfa.recoveryCodes.verify({ code: firstCode })).error?.code)
      .toBe('mfa_verification_failed')
    expect((await secondClient.auth.mfa.recoveryCodes.getStatus()).data?.remaining).toBe(2)

    const regenerated = await client.auth.mfa.recoveryCodes.regenerate()
    expect(regenerated.error).toBeNull()
    expect(regenerated.data?.codes).toHaveLength(3)
    expect(regenerated.data?.codes).not.toContain(firstCode)
    expect((await secondClient.auth.mfa.recoveryCodes.verify({ code: firstCode })).error?.code)
      .toBe('mfa_verification_failed')

    const deleted = await client.auth.mfa.recoveryCodes.unenroll()
    expect(deleted.error).toBeNull()
    expect(deleted.data?.id).toBe(generated.data?.id)
    expect((await client.auth.mfa.recoveryCodes.getStatus()).error?.code).toBe('mfa_factor_not_found')
  })
})
