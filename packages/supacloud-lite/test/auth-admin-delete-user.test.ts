import { describe, expect, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { createLiteBackend } from '../src/index.js'

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
}

describe('Auth admin delete user compatibility', () => {
  test('soft-deletes users, revokes sessions, and preserves the auth row', async () => {
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
        email: 'soft-delete@example.com',
        password: 'correct-horse-battery-staple',
        email_confirm: true,
      })
      expect(created.error).toBeNull()
      const userId = created.data.user!.id
      const signedIn = await anonClient.auth.signInWithPassword({
        email: 'soft-delete@example.com',
        password: 'correct-horse-battery-staple',
      })
      expect(signedIn.error).toBeNull()
      const refreshToken = signedIn.data.session!.refresh_token

      const deleted = await serviceClient.auth.admin.deleteUser(userId, true)
      expect(deleted.error).toBeNull()
      expect(deleted.data.user?.id).toBe(userId)
      expect((await backend.db.query(
        `select deleted_at is not null as deleted, revoked from auth.users u
         left join auth.refresh_tokens rt on rt.user_id = u.id and rt.token = $1
         where u.id = $2`,
        [refreshToken, userId],
      )).rows).toEqual([{ deleted: true, revoked: true }])

      const refreshed = await anonClient.auth.refreshSession()
      expect(refreshed.error).not.toBeNull()
      expect(refreshed.data.session).toBeNull()
      const lookup = await serviceClient.auth.admin.getUserById(userId)
      expect(lookup.error).toBeNull()
      expect(lookup.data.user?.id).toBe(userId)
    } finally {
      await backend.close()
    }
  })

  test('hard-deletes users by default and returns the deleted user shape', async () => {
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
        email: 'hard-delete@example.com',
        email_confirm: true,
      })
      expect(created.error).toBeNull()
      const userId = created.data.user!.id
      const deleted = await serviceClient.auth.admin.deleteUser(userId)
      expect(deleted.error).toBeNull()
      expect(deleted.data.user?.id).toBe(userId)
      expect((await backend.db.query('select id from auth.users where id = $1', [userId])).rows).toEqual([])
    } finally {
      await backend.close()
    }
  })
})
