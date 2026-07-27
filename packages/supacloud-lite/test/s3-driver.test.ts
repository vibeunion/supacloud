import { describe, expect, test } from 'bun:test'
import {
  S3StorageDriver,
  type S3StorageClientLike,
} from '../src/vendor/tinbase/storage/s3-driver.js'

type MockFile = {
  bytes: Uint8Array
}

function createMockClient(initial: Record<string, Uint8Array> = {}) {
  const files = new Map<string, MockFile>(
    Object.entries(initial).map(([key, bytes]) => [key, { bytes }])
  )
  const calls: string[] = []
  const client: S3StorageClientLike = {
    file(path) {
      calls.push(path)
      return {
        async exists() {
          return files.has(path)
        },
        async bytes() {
          const file = files.get(path)
          if (!file) {
            const error = new Error('object not found') as Error & { status: number }
            error.status = 404
            throw error
          }
          return file.bytes
        },
        async write(data) {
          files.set(path, { bytes: data })
        },
        async delete() {
          files.delete(path)
        },
      }
    },
  }
  return { client, files, calls }
}

describe('S3StorageDriver', () => {
  test('uses Bun.S3Client against a custom S3-compatible endpoint', async () => {
    const objects = new Map<string, Uint8Array>()
    const requests: Array<{ method: string; path: string }> = []
    const missing = () =>
      new Response('<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>missing</Message></Error>', {
        status: 404,
        headers: { 'content-type': 'application/xml' },
      })
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        requests.push({ method: request.method, path })
        if (request.method === 'PUT') {
          objects.set(path, new Uint8Array(await request.arrayBuffer()))
          return new Response(null, { status: 200, headers: { etag: '"test"' } })
        }
        if (request.method === 'HEAD') {
          const bytes = objects.get(path)
          return bytes
            ? new Response(null, { status: 200, headers: { 'content-length': String(bytes.length) } })
            : missing()
        }
        if (request.method === 'GET') {
          const bytes = objects.get(path)
          return bytes ? new Response(bytes as BodyInit) : missing()
        }
        if (request.method === 'DELETE') {
          objects.delete(path)
          return new Response(null, { status: 204 })
        }
        return new Response(null, { status: 405 })
      },
    })
    const driver = new S3StorageDriver({
      bucket: 'test-bucket',
      prefix: 'lite',
      endpoint: server.url.origin,
      region: 'us-east-1',
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    })

    try {
      const payload = new TextEncoder().encode('remote object')
      await driver.put('docs/test.txt', payload)
      expect(await driver.get('docs/test.txt')).toEqual(payload)
      await driver.delete('docs/test.txt')
      expect(await driver.get('docs/test.txt')).toBeNull()
      expect(requests.map((request) => request.method)).toEqual(['PUT', 'HEAD', 'GET', 'DELETE', 'HEAD'])
      expect(requests.every((request) => request.path === '/test-bucket/lite/docs/test.txt')).toBe(true)
    } finally {
      server.stop(true)
    }
  }, 20_000)

  test('applies a normalized prefix to all object operations', async () => {
    const mock = createMockClient({ 'tenant/assets/existing.txt': new Uint8Array([1, 2]) })
    const driver = new S3StorageDriver({ prefix: 'tenant/temp/../assets\\./' }, mock.client)

    await driver.put('nested/temp/../new.txt', new Uint8Array([3, 4]))
    expect(await driver.get('existing.txt')).toEqual(new Uint8Array([1, 2]))
    await driver.deleteMany(['existing.txt', 'nested/new.txt'])

    expect(mock.calls).toEqual([
      'tenant/assets/nested/new.txt',
      'tenant/assets/existing.txt',
      'tenant/assets/existing.txt',
      'tenant/assets/nested/new.txt',
    ])
    expect(mock.files.size).toBe(0)
  })

  test('returns null for a missing object', async () => {
    const mock = createMockClient()
    const driver = new S3StorageDriver({}, mock.client)

    expect(await driver.get('missing.txt')).toBeNull()
  })

  test('returns null when an object disappears between exists and bytes', async () => {
    const client: S3StorageClientLike = {
      file() {
        return {
          exists: async () => true,
          bytes: async () => {
            const error = new Error('object disappeared') as Error & { code: string }
            error.code = 'NoSuchKey'
            throw error
          },
          write: async () => undefined,
          delete: async () => undefined,
        }
      },
    }

    expect(await new S3StorageDriver({}, client).get('missing.txt')).toBeNull()
  })

  test('propagates authentication and network errors', async () => {
    const authError = new Error('access denied')
    const networkError = new Error('connection reset')
    const authClient: S3StorageClientLike = {
      file() {
        return {
          exists: async () => {
            throw authError
          },
          bytes: async () => new Uint8Array(),
          write: async () => undefined,
          delete: async () => undefined,
        }
      },
    }
    const networkClient: S3StorageClientLike = {
      file() {
        return {
          exists: async () => true,
          bytes: async () => {
            throw networkError
          },
          write: async () => undefined,
          delete: async () => undefined,
        }
      },
    }

    await expect(new S3StorageDriver({}, authClient).get('private.txt')).rejects.toBe(authError)
    await expect(new S3StorageDriver({}, networkClient).get('private.txt')).rejects.toBe(networkError)
  })

  test('rejects absolute paths and traversal beyond the configured prefix', async () => {
    const mock = createMockClient()
    const driver = new S3StorageDriver({ prefix: 'assets' }, mock.client)

    await expect(driver.get('../outside.txt')).rejects.toThrow('key must not escape its root')
    await expect(driver.get('/outside.txt')).rejects.toThrow('key must not be absolute')
    await expect(driver.get('C:\\outside.txt')).rejects.toThrow('key must not be absolute')
    expect(() => new S3StorageDriver({ prefix: '../outside' }, mock.client)).toThrow(
      'prefix must not escape its root'
    )
  })
})
