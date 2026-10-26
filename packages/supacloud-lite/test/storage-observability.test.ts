import { describe, expect, test } from 'bun:test'
import { createLiteBackend } from '../src/index.js'
import { testTimeout } from './helpers/timeouts.js'

const headers = (backend: Awaited<ReturnType<typeof createLiteBackend>>, key: string) => ({
  apikey: backend.anonKey,
  authorization: `Bearer ${key}`,
})

describe('Storage observability endpoints', () => {
  test('exposes public status and protects metadata metrics with the service role', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      buckets: [{ id: 'assets', public: false, fileSizeLimit: null, allowedMimeTypes: null }],
      log: () => {},
    })
    try {
      const status = await backend.fetch('http://local/storage/v1/status')
      expect(status.status).toBe(200)
      expect(await status.json()).toMatchObject({
        status: 'ok',
        name: 'supacloud-lite-storage',
        version: expect.any(String),
      })

      const upload = await backend.fetch('http://local/storage/v1/object/assets/hello.txt', {
        method: 'POST',
        headers: { ...headers(backend, backend.serviceRoleKey), 'content-type': 'text/plain' },
        body: 'hello metrics',
      })
      expect(upload.status).toBe(200)

      const denied = await backend.fetch('http://local/storage/v1/metrics', {
        headers: headers(backend, backend.anonKey),
      })
      expect(denied.status).toBe(403)

      const metrics = await backend.fetch('http://local/storage/v1/metrics', {
        headers: headers(backend, backend.serviceRoleKey),
      })
      expect(metrics.status).toBe(200)
      expect(metrics.headers.get('content-type')).toContain('text/plain')
      const text = await metrics.text()
      expect(text).toContain('storage_buckets_total 1')
      expect(text).toContain('storage_objects_total 1')
      expect(text).toContain('storage_object_bytes_total 13')
      expect(text).toContain('# TYPE storage_object_bytes_total gauge')
    } finally {
      await backend.close()
    }
  }, testTimeout(30_000))
})
