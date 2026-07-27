import { describe, expect, test } from 'bun:test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createLiteBackend, type StorageDriver } from '../src/index.js'

class FailingStorageDriver implements StorageDriver {
  private objects = new Map<string, Uint8Array>()
  failAfterWrite = false
  failOnTextAfterWrite: string | null = null
  failAfterDeleteMany = false
  cleanupFailureMode: 'ignore' | 'propagate' = 'ignore'

  async put(key: string, data: Uint8Array): Promise<void> {
    this.objects.set(key, data.slice())
    if (this.failAfterWrite || (this.failOnTextAfterWrite !== null && new TextDecoder().decode(data) === this.failOnTextAfterWrite)) {
      this.failAfterWrite = false
      this.failOnTextAfterWrite = null
      throw new Error('simulated storage failure')
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key)?.slice() ?? null
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (const key of keys) this.objects.delete(key)
    if (this.failAfterDeleteMany) {
      this.failAfterDeleteMany = false
      throw new Error('simulated delete-many failure')
    }
  }
}

describe('Storage atomicity', () => {
  test('restores old bytes and metadata when an upsert driver write fails', async () => {
    const driver = new FailingStorageDriver()
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      storageDriver: driver,
      buckets: [{ id: 'assets', public: false, fileSizeLimit: null, allowedMimeTypes: null }],
      log: () => {},
    })
    const client = createClient('http://local', backend.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: backend.fetch },
    })

    try {
      const initial = await client.storage.from('assets').upload('atomic.txt', new TextEncoder().encode('old'), {
        contentType: 'text/plain',
        upsert: true,
      })
      expect(initial.error).toBeNull()
      const initialMetadata = await backend.db.query<{ version: string }>(
        `select version from storage.objects where bucket_id = 'assets' and name = 'atomic.txt'`
      )

      driver.failAfterWrite = true
      const failed = await client.storage.from('assets').upload('atomic.txt', new TextEncoder().encode('new-value'), {
        contentType: 'text/plain',
        upsert: true,
      })
      expect(failed.error).not.toBeNull()

      const downloaded = await client.storage.from('assets').download('atomic.txt')
      expect(downloaded.error).toBeNull()
      expect(await downloaded.data!.text()).toBe('old')
      const metadata = await backend.db.query<{ metadata: { size: number }; version: string }>(
        `select metadata, version from storage.objects where bucket_id = 'assets' and name = 'atomic.txt'`
      )
      expect(metadata.rows[0]?.metadata.size).toBe(3)
      expect(metadata.rows[0]?.version).toBe(initialMetadata.rows[0]?.version)
    } finally {
      await backend.close()
    }
  })

  test('preserves both objects when move targets an existing key', async () => {
    const { backend, client } = await createStorageHarness(new FailingStorageDriver())
    try {
      expect((await client.storage.from('assets').upload('source.txt', 'source', { upsert: true })).error).toBeNull()
      expect((await client.storage.from('assets').upload('target.txt', 'target', { upsert: true })).error).toBeNull()

      expect((await client.storage.from('assets').move('source.txt', 'target.txt')).error).not.toBeNull()
      expect(await downloadText(client, 'source.txt')).toBe('source')
      expect(await downloadText(client, 'target.txt')).toBe('target')
    } finally {
      await backend.close()
    }
  })

  test('serializes concurrent upserts before applying byte rollback', async () => {
    const driver = new FailingStorageDriver()
    const { backend, client } = await createStorageHarness(driver)
    try {
      expect((await client.storage.from('assets').upload('race.txt', 'old', { upsert: true })).error).toBeNull()

      driver.failOnTextAfterWrite = 'B'
      const [successful, failed] = await Promise.all([
        client.storage.from('assets').upload('race.txt', 'A', { upsert: true }),
        client.storage.from('assets').upload('race.txt', 'B', { upsert: true }),
      ])
      expect(successful.error).toBeNull()
      expect(failed.error).not.toBeNull()
      expect(await downloadText(client, 'race.txt')).toBe('A')
    } finally {
      await backend.close()
    }
  })

  test('reads legacy object rows from their bucket path', async () => {
    const driver = new FailingStorageDriver()
    const { backend, client } = await createStorageHarness(driver)
    try {
      await driver.put('assets/legacy.txt', new TextEncoder().encode('legacy'))
      await backend.db.query(
        `insert into storage.objects (bucket_id, name, owner, metadata, version)
         values ('assets', 'legacy.txt', null, $1::jsonb, $2)`,
        [
          JSON.stringify({
            size: 6,
            mimetype: 'text/plain',
            cacheControl: 'no-cache',
            lastModified: new Date().toISOString(),
          }),
          crypto.randomUUID(),
        ]
      )

      expect(await downloadText(client, 'legacy.txt')).toBe('legacy')
    } finally {
      await backend.close()
    }
  })

  test('keeps deleted metadata authoritative when old-byte cleanup fails', async () => {
    const driver = new FailingStorageDriver()
    const { backend, client } = await createStorageHarness(driver)
    try {
      expect((await client.storage.from('assets').upload('delete.txt', 'keep-me', { upsert: true })).error).toBeNull()

      driver.failAfterDeleteMany = true
      expect((await client.storage.from('assets').remove(['delete.txt'])).error).toBeNull()
      expect((await client.storage.from('assets').download('delete.txt')).error).not.toBeNull()
      const metadata = await backend.db.query(
        `select 1 from storage.objects where bucket_id = 'assets' and name = 'delete.txt'`
      )
      expect(metadata.rows).toHaveLength(0)
    } finally {
      await backend.close()
    }
  })

  test('surfaces strict remote cleanup failures after metadata deletion', async () => {
    const driver = new FailingStorageDriver()
    driver.cleanupFailureMode = 'propagate'
    const { backend, client } = await createStorageHarness(driver)
    try {
      expect((await client.storage.from('assets').upload('remote-delete.txt', 'keep-me', { upsert: true })).error).toBeNull()

      driver.failAfterDeleteMany = true
      const removed = await client.storage.from('assets').remove(['remote-delete.txt'])
      expect(removed.error).not.toBeNull()
      const metadata = await backend.db.query(
        `select 1 from storage.objects where bucket_id = 'assets' and name = 'remote-delete.txt'`
      )
      expect(metadata.rows).toHaveLength(0)
    } finally {
      await backend.close()
    }
  })

  test('keeps a moved object readable when old-byte cleanup fails', async () => {
    const driver = new FailingStorageDriver()
    const { backend, client } = await createStorageHarness(driver)
    try {
      expect((await client.storage.from('assets').upload('source.txt', 'source', { upsert: true })).error).toBeNull()

      driver.failAfterDeleteMany = true
      expect((await client.storage.from('assets').move('source.txt', 'moved.txt')).error).toBeNull()
      expect((await client.storage.from('assets').download('source.txt')).error).not.toBeNull()
      expect(await downloadText(client, 'moved.txt')).toBe('source')
    } finally {
      await backend.close()
    }
  })

  test('enforces destination bucket limits for cross-bucket move and copy', async () => {
    const { backend, client } = await createStorageHarness(new FailingStorageDriver())
    try {
      expect(
        (await client.storage.from('assets').upload('source.txt', 'source', { contentType: 'text/plain', upsert: true }))
          .error
      ).toBeNull()

      expect(
        (await client.storage.from('assets').move('source.txt', 'moved.txt', { destinationBucket: 'restricted' })).error
      ).not.toBeNull()
      expect(
        (await client.storage.from('assets').copy('source.txt', 'copied.txt', { destinationBucket: 'restricted' })).error
      ).not.toBeNull()
      expect(await downloadText(client, 'source.txt')).toBe('source')
      expect((await client.storage.from('restricted').download('moved.txt')).error).not.toBeNull()
      expect((await client.storage.from('restricted').download('copied.txt')).error).not.toBeNull()
    } finally {
      await backend.close()
    }
  })
})

async function createStorageHarness(driver: StorageDriver) {
  const backend = await createLiteBackend({
    jwtSecret: 'x'.repeat(64),
    vaultKey: 'y'.repeat(64),
    storageDriver: driver,
    buckets: [
      { id: 'assets', public: false, fileSizeLimit: null, allowedMimeTypes: null },
      { id: 'restricted', public: false, fileSizeLimit: 1, allowedMimeTypes: ['application/json'] },
    ],
    log: () => {},
  })
  const client = createClient('http://local', backend.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: backend.fetch },
  })
  return { backend, client }
}

async function downloadText(client: SupabaseClient<any, any, any, any, any>, key: string): Promise<string> {
  const downloaded = await client.storage.from('assets').download(key)
  expect(downloaded.error).toBeNull()
  return downloaded.data!.text()
}
