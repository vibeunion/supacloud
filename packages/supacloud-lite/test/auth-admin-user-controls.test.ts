import { describe, expect, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { createLiteBackend } from '../src/index.js'

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
}

describe('Auth admin user controls', () => {
  test('updates phone confirmation and ban duration through the admin SDK', async () => {
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
        email: 'admin-controls@example.com',
        password: 'correct-horse-battery-staple',
        email_confirm: true,
      })
      expect(created.error).toBeNull()
      const userId = created.data.user!.id

      const updated = await serviceClient.auth.admin.updateUserById(userId, {
        phone: '+14155550123',
        phone_confirm: true,
        ban_duration: '1h',
      })
      expect(updated.error).toBeNull()
      expect(updated.data.user).toMatchObject({
        id: userId,
        phone: '+14155550123',
        phone_confirmed_at: expect.any(String),
      })
      expect(updated.data.user?.identities).toEqual(expect.arrayContaining([
        expect.objectContaining({ provider: 'phone', id: '+14155550123' }),
      ]))
      expect(updated.data.user?.app_metadata.providers).toEqual(['email', 'phone'])
      expect((await backend.db.query(
        `select phone, phone_confirmed_at, banned_until > now() as banned from auth.users where id = $1`,
        [userId],
      )).rows).toEqual([
        { phone: '+14155550123', phone_confirmed_at: expect.any(Date), banned: true },
      ])

      const bannedLogin = await anonClient.auth.signInWithPassword({
        email: 'admin-controls@example.com',
        password: 'correct-horse-battery-staple',
      })
      expect(bannedLogin.error?.code).toBe('user_banned')

      const unbanned = await serviceClient.auth.admin.updateUserById(userId, {
        ban_duration: 'none',
        phone_confirm: false,
      })
      expect(unbanned.error).toBeNull()
      expect(unbanned.data.user?.phone_confirmed_at).toBeNull()
      expect((await backend.db.query(
        `select banned_until, phone_confirmed_at from auth.users where id = $1`,
        [userId],
      )).rows).toEqual([{ banned_until: null, phone_confirmed_at: null }])
    } finally {
      await backend.close()
    }
  })

  test('rejects duplicate phones and malformed ban durations', async () => {
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
        email: 'first-controls@example.com',
        email_confirm: true,
      })
      const second = await serviceClient.auth.admin.createUser({
        email: 'second-controls@example.com',
        email_confirm: true,
      })
      expect(first.error).toBeNull()
      expect(second.error).toBeNull()

      const duplicate = await serviceClient.auth.admin.updateUserById(second.data.user!.id, {
        phone: '+14155550124',
      })
      expect(duplicate.error).toBeNull()
      const conflict = await serviceClient.auth.admin.updateUserById(first.data.user!.id, {
        phone: '+14155550124',
      })
      expect(conflict.error?.code).toBe('phone_exists')

      const malformed = await serviceClient.auth.admin.updateUserById(first.data.user!.id, {
        ban_duration: 'tomorrow',
      })
      expect(malformed.error?.code).toBe('validation_failed')
    } finally {
      await backend.close()
    }
  })
})
