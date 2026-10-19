import { describe, expect, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { createLiteBackend } from '../src/index.js'

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
}

describe('Auth admin phone-only users', () => {
  test('creates a user with only a phone identity', async () => {
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
        phone: '+14155550127',
        phone_confirm: true,
        user_metadata: { source: 'phone-only' },
      })
      expect(created.error).toBeNull()
      expect(created.data.user).toMatchObject({
        email: '',
        phone: '+14155550127',
        phone_confirmed_at: expect.any(String),
        app_metadata: { provider: 'phone', providers: ['phone'] },
        user_metadata: { source: 'phone-only' },
      })
      expect(created.data.user?.identities).toEqual([
        expect.objectContaining({ provider: 'phone', id: '+14155550127' }),
      ])
      expect((await backend.db.query(
        `select email, phone from auth.users where phone = $1`,
        ['+14155550127'],
      )).rows).toEqual([{ email: null, phone: '+14155550127' }])
    } finally {
      await backend.close()
    }
  })

  test('requires at least one email or phone identifier', async () => {
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
      const result = await serviceClient.auth.admin.createUser({ user_metadata: { empty: true } })
      expect(result.error?.code).toBe('validation_failed')
    } finally {
      await backend.close()
    }
  })
})
