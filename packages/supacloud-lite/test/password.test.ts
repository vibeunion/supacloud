import { describe, expect, test } from 'bun:test'
import { hashPassword, verifyPassword } from '../src/vendor/tinbase/auth/password.js'

describe('Auth password compatibility', () => {
  test('creates and verifies GoTrue-compatible bcrypt hashes with Bun', async () => {
    const hash = await hashPassword('correct-horse-battery-staple')
    expect(hash).toMatch(/^\$2[aby]\$10\$/)
    expect(await verifyPassword('correct-horse-battery-staple', hash)).toBe(true)
    expect(await verifyPassword('wrong-password', hash)).toBe(false)
  })

  test('accepts imported bcrypt hashes', async () => {
    const imported = await Bun.password.hash('imported-user-password', { algorithm: 'bcrypt', cost: 10 })
    expect(await verifyPassword('imported-user-password', imported)).toBe(true)
  })

  test('retains verification for legacy PBKDF2 hashes', async () => {
    const fixture =
      'pbkdf2$100000$000102030405060708090a0b0c0d0e0f$ebc912e03a48689698c21563a3f9c36e5c67d4c830f463de3b147ea1bf038166'
    expect(await verifyPassword('legacy-password', fixture)).toBe(true)
    expect(await verifyPassword('wrong-password', fixture)).toBe(false)
  })

  test('rejects malformed PBKDF2 hashes without throwing', async () => {
    expect(await verifyPassword('password', 'pbkdf2$bad$zz$00')).toBe(false)
  })
})
