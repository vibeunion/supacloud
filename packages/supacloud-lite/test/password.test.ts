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
})
