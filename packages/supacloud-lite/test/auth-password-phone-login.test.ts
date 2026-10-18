import { describe, expect, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { createLiteBackend } from '../src/index.js'

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
}

describe('Auth password phone login', () => {
  test('signs in a confirmed phone-only user with a password', async () => {
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
        phone: '+14155550128',
        password: 'correct-horse-battery-staple',
        phone_confirm: true,
      })
      expect(created.error).toBeNull()
      const signedIn = await anonClient.auth.signInWithPassword({
        phone: '+14155550128',
        password: 'correct-horse-battery-staple',
      })
      expect(signedIn.error).toBeNull()
      expect(signedIn.data.user).toMatchObject({ phone: '+14155550128', email: '' })
      expect(signedIn.data.session?.access_token).toBeString()
    } finally {
      await backend.close()
    }
  })

  test('rejects an unconfirmed phone password login', async () => {
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
        phone: '+14155550129',
        password: 'correct-horse-battery-staple',
      })
      expect(created.error).toBeNull()
      const signedIn = await anonClient.auth.signInWithPassword({
        phone: '+14155550129',
        password: 'correct-horse-battery-staple',
      })
      expect(signedIn.error?.code).toBe('phone_not_confirmed')
    } finally {
      await backend.close()
    }
  })
})
