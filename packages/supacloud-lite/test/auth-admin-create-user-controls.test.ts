import { describe, expect, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { createLiteBackend } from '../src/index.js'

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
}

describe('Auth admin create user controls', () => {
  test('defaults email to unconfirmed and persists phone and ban controls', async () => {
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

    try {
      const created = await serviceClient.auth.admin.createUser({
        email: 'create-controls@example.com',
        password: 'correct-horse-battery-staple',
        phone: '+14155550125',
        phone_confirm: true,
        ban_duration: '2h',
        user_metadata: { source: 'admin-create' },
      })
      expect(created.error).toBeNull()
      expect(created.data.user).toMatchObject({
        email: 'create-controls@example.com',
        email_confirmed_at: null,
        phone: '+14155550125',
        phone_confirmed_at: expect.any(String),
        user_metadata: { source: 'admin-create' },
      })
      expect(created.data.user?.identities).toEqual(expect.arrayContaining([
        expect.objectContaining({ provider: 'email', id: expect.any(String) }),
        expect.objectContaining({ provider: 'phone', id: '+14155550125' }),
      ]))
      expect((await backend.db.query(
        `select email_confirmed_at, phone, phone_confirmed_at, banned_until > now() as banned
         from auth.users where email = $1`,
        ['create-controls@example.com'],
      )).rows).toEqual([{
        email_confirmed_at: null,
        phone: '+14155550125',
        phone_confirmed_at: expect.any(Date),
        banned: true,
      }])
    } finally {
      await backend.close()
    }
  })

  test('rejects duplicate phone numbers and invalid control values', async () => {
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

    try {
      const first = await serviceClient.auth.admin.createUser({
        email: 'first-create-controls@example.com',
        phone: '+14155550126',
      })
      expect(first.error).toBeNull()
      const duplicate = await serviceClient.auth.admin.createUser({
        email: 'second-create-controls@example.com',
        phone: '+14155550126',
      })
      expect(duplicate.error?.code).toBe('phone_exists')
      const malformed = await serviceClient.auth.admin.createUser({
        email: 'invalid-create-controls@example.com',
        ban_duration: 'tomorrow',
      })
      expect(malformed.error?.code).toBe('validation_failed')
    } finally {
      await backend.close()
    }
  })
})
