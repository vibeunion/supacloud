import { describe, expect, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { createLiteBackend } from '../src/index.js'

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
}

describe('Auth admin list users pagination', () => {
  test('honors page and perPage and exposes SDK pagination metadata', async () => {
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
      for (let index = 0; index < 5; index += 1) {
        const created = await serviceClient.auth.admin.createUser({
          email: `list-page-${index}@example.com`,
          email_confirm: true,
        })
        expect(created.error).toBeNull()
      }

      const secondPage = await serviceClient.auth.admin.listUsers({ page: 2, perPage: 2 })
      expect(secondPage.error).toBeNull()
      expect(secondPage.data.users).toHaveLength(2)
      expect(secondPage.data.users.map((user) => user.email)).toEqual([
        'list-page-2@example.com',
        'list-page-1@example.com',
      ])
      expect(secondPage.data).toMatchObject({ nextPage: 3, lastPage: 3, total: 5 })

      const lastPage = await serviceClient.auth.admin.listUsers({ page: 3, perPage: 2 })
      expect(lastPage.error).toBeNull()
      expect(lastPage.data.users.map((user) => user.email)).toEqual(['list-page-0@example.com'])
      expect(lastPage.data).toMatchObject({ nextPage: null, lastPage: 3, total: 5 })
    } finally {
      await backend.close()
    }
  })

  test('rejects invalid pagination values', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      apiUrl: 'http://local',
      log: () => {},
    })
    try {
      const response = await backend.fetch('http://local/auth/v1/admin/users?page=0&per_page=1001', {
        headers: { apikey: backend.serviceRoleKey, authorization: `Bearer ${backend.serviceRoleKey}` },
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error_code: 'validation_failed' })
    } finally {
      await backend.close()
    }
  })
})
