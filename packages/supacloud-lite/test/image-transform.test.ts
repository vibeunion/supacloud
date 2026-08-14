import { describe, expect, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { createLiteBackend } from '../src/index.js'
import {
  parseImageTransform,
  transformImage,
  type ImageTransformOptions,
  type ImageTransformResult,
} from '../src/runtime/storage/image-transform.js'
import { ImageTransformCache } from '../src/runtime/storage/image-transform-cache.js'
import { StorageHandler } from '../src/runtime/storage/handler.js'
import type { StorageDriver } from '../src/runtime/types.js'

const sourcePng = await new Bun.Image(createBmp(4, 2)).png().bytes()

describe('storage image transforms', () => {
  test('rejects cover and invalid transform parameters', () => {
    const cover = parseImageTransform(new URLSearchParams('width=8&resize=cover'))
    expect(cover.ok).toBe(false)
    if (!cover.ok) expect(cover.status).toBe(422)

    const invalidWidth = parseImageTransform(new URLSearchParams('width=0&resize=contain'))
    expect(invalidWidth.ok).toBe(false)
    if (!invalidWidth.ok) expect(invalidWidth.status).toBe(400)

    const invalidQuality = parseImageTransform(new URLSearchParams('format=png&quality=80'))
    expect(invalidQuality.ok).toBe(false)
    if (!invalidQuality.ok) expect(invalidQuality.status).toBe(400)

    const oversizedWidth = parseImageTransform(new URLSearchParams('width=2501&resize=contain'))
    expect(oversizedWidth.ok).toBe(false)
    if (!oversizedWidth.ok) expect(oversizedWidth.status).toBe(400)

    const implicitCover = parseImageTransform(new URLSearchParams('width=100&height=100'))
    expect(implicitCover.ok).toBe(false)
    if (!implicitCover.ok) expect(implicitCover.status).toBe(422)
  })

  test('maps contain and fill to Bun.Image resize semantics', async () => {
    const contain = await transformImage(sourcePng, parseOptions('width=4&height=4&resize=contain&format=png'))
    expect(await dimensions(contain)).toEqual({ width: 4, height: 2 })

    const fill = await transformImage(sourcePng, parseOptions('width=4&height=4&resize=fill&format=png'))
    expect(await dimensions(fill)).toEqual({ width: 4, height: 4 })
  })

  test('keeps aspect ratio for width-only and height-only transforms', async () => {
    const widthOnly = await transformImage(sourcePng, parseOptions('width=8&resize=contain&format=png'))
    expect(await dimensions(widthOnly)).toEqual({ width: 8, height: 4 })

    const heightOnly = await transformImage(sourcePng, parseOptions('height=4&resize=fill&format=png'))
    expect(await dimensions(heightOnly)).toEqual({ width: 8, height: 4 })
  })

  test('supports origin, jpeg, png, and webp with scoped quality', async () => {
    const origin = await transformImage(sourcePng, parseOptions('resize=contain&format=origin'))
    expectSuccess(origin, 'image/png')

    const jpeg = await transformImage(sourcePng, parseOptions('resize=contain&format=jpeg&quality=80'))
    expectSuccess(jpeg, 'image/jpeg')

    const png = await transformImage(sourcePng, parseOptions('resize=contain&format=png'))
    expectSuccess(png, 'image/png')

    const webp = await transformImage(sourcePng, parseOptions('resize=contain&format=webp&quality=80'))
    expectSuccess(webp, 'image/webp')

    const originWithQuality = await transformImage(sourcePng, parseOptions('resize=contain&format=origin&quality=80'))
    expect(originWithQuality.ok).toBe(false)
    if (!originWithQuality.ok) expect(originWithQuality.status).toBe(400)
  })

  test('returns a compatibility error for non-image input', async () => {
    const result = await transformImage(new TextEncoder().encode('not an image'), parseOptions('format=png'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(415)
  })

  test('enforces the actual Blob size when metadata understates it', async () => {
    const oversizedBlob = new Blob([new Uint8Array(25 * 1024 * 1024 + 1)])
    const result = await transformImage(oversizedBlob, parseOptions('format=png'), 1)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(413)
  })

  test('preserves cache control and sets transformed response headers', async () => {
    const driver: StorageDriver = {
      put: async () => undefined,
      get: async () => sourcePng,
      delete: async () => undefined,
      deleteMany: async () => undefined,
    }
    const handler = new StorageHandler(null as never, driver, { jwtSecret: 'test' })
    const transformResponse = (
      handler as unknown as {
        transformImageResponse(row: unknown, url: URL, head: boolean): Promise<Response>
      }
    ).transformImageResponse.bind(handler)
    const row = {
      id: 'object-id',
      bucket_id: 'images',
      name: 'source.png',
      owner: null,
      version: null,
      metadata: {
        size: sourcePng.byteLength,
        cacheControl: 'public, max-age=3600',
        mimetype: 'image/png',
      },
      created_at: null,
      updated_at: null,
      last_accessed_at: null,
    }
    const url = new URL('http://localhost/storage/v1/render/image/public/bucket/image.png?width=8&format=webp')

    const response = await transformResponse(row, url, false)
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(response.headers.get('content-type')).toBe('image/webp')
    expect(response.headers.get('content-length')).toBe(String((await response.clone().arrayBuffer()).byteLength))
    expect(response.headers.has('content-disposition')).toBe(false)

    const head = await transformResponse(row, url, true)
    expect(head.headers.get('content-length')).toBe(response.headers.get('content-length'))
    expect((await head.arrayBuffer()).byteLength).toBe(0)
  })

  test('serves public and signed transforms through storage-compatible routes', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      buckets: [{ id: 'images', public: true, fileSizeLimit: null, allowedMimeTypes: ['image/png'] }],
    })
    const client = createClient('http://local', backend.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: backend.fetch },
    })

    try {
      const upload = await client.storage.from('images').upload('source.png', sourcePng, {
        contentType: 'image/png',
        upsert: true,
      })
      expect(upload.error).toBeNull()

      const publicResponse = await backend.fetch(
        new Request(
          'http://local/storage/v1/render/image/public/images/source.png?width=8&height=8&resize=contain&format=webp'
        )
      )
      expect(publicResponse.status).toBe(200)
      expect(publicResponse.headers.get('content-type')).toBe('image/webp')
      expect(await responseDimensions(publicResponse)).toEqual({ width: 8, height: 4 })

      const authenticated = await client.storage.from('images').download('source.png', {
        transform: { width: 5, height: 5, resize: 'fill' },
      })
      expect(authenticated.error).toBeNull()
      const authenticatedMetadata = await new Bun.Image(await authenticated.data!.bytes()).metadata()
      expect(authenticatedMetadata).toMatchObject({ width: 5, height: 5, format: 'png' })

      const signed = await client.storage.from('images').createSignedUrl('source.png', 60, {
        transform: { width: 6, height: 6, resize: 'contain', format: 'origin' },
      })
      expect(signed.error).toBeNull()
      expect(signed.data?.signedUrl).toContain('/storage/v1/render/image/sign/images/source.png')
      const signedResponse = await backend.fetch(new Request(signed.data!.signedUrl))
      expect(signedResponse.status).toBe(200)
      expect(signedResponse.headers.get('content-type')).toBe('image/png')
      expect(await responseDimensions(signedResponse)).toEqual({ width: 6, height: 3 })
    } finally {
      await backend.close()
    }
  }, 20_000)

  test('caches immutable variants and invalidates them after an upsert', async () => {
    const driver = new CountingBlobDriver()
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      storageDriver: driver,
      buckets: [{ id: 'images', public: true, fileSizeLimit: null, allowedMimeTypes: ['image/png'] }],
    })
    const client = createClient('http://local', backend.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: backend.fetch },
    })
    const transformUrl =
      'http://local/storage/v1/render/image/public/images/source.png?width=8&height=8&resize=contain&format=webp'

    try {
      expect(
        (await client.storage.from('images').upload('source.png', sourcePng, { contentType: 'image/png' })).error
      ).toBeNull()
      expect((await backend.fetch(new Request(transformUrl))).status).toBe(200)
      expect((await backend.fetch(new Request(transformUrl))).status).toBe(200)
      expect(driver.blobReads).toBe(1)

      const replacement = await new Bun.Image(createBmp(3, 3)).png().bytes()
      expect(
        (
          await client.storage.from('images').upload('source.png', replacement, {
            contentType: 'image/png',
            upsert: true,
          })
        ).error
      ).toBeNull()
      expect((await backend.fetch(new Request(transformUrl))).status).toBe(200)
      expect(driver.blobReads).toBe(2)
    } finally {
      await backend.close()
    }
  }, 20_000)

  test('singleflights identical work and globally serializes transforms', async () => {
    const firstCache = new ImageTransformCache()
    const secondCache = new ImageTransformCache()
    let operations = 0
    let active = 0
    let peak = 0
    const operation = async (): Promise<ImageTransformResult> => {
      operations += 1
      active += 1
      peak = Math.max(peak, active)
      await Bun.sleep(10)
      active -= 1
      return { ok: true, bytes: new Uint8Array([operations]), contentType: 'image/png' }
    }

    const [first, duplicate, second] = await Promise.all([
      firstCache.getOrTransform('v2-a\0same', operation),
      firstCache.getOrTransform('v2-a\0same', operation),
      secondCache.getOrTransform('v2-b\0other', operation),
    ])

    expect(first).toBe(duplicate)
    expect(second.ok).toBe(true)
    expect(operations).toBe(2)
    expect(peak).toBe(1)
  })

  test('releases the global transform permit after failure', async () => {
    const cache = new ImageTransformCache()
    await expect(
      cache.getOrTransform('v2-failure', async () => {
        throw new Error('decode failed')
      })
    ).rejects.toThrow('decode failed')

    const result = await cache.getOrTransform('v2-success', async () => ({
      ok: true,
      bytes: new Uint8Array([1]),
      contentType: 'image/png',
    }))
    expect(result.ok).toBe(true)
  })
})

class CountingBlobDriver implements StorageDriver {
  private files = new Map<string, Uint8Array>()
  blobReads = 0

  async put(key: string, data: Uint8Array): Promise<void> {
    this.files.set(key, data)
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.files.get(key) ?? null
  }

  async getBlob(key: string): Promise<Blob | null> {
    this.blobReads += 1
    const bytes = this.files.get(key)
    return bytes ? new Blob([Uint8Array.from(bytes).buffer]) : null
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key)
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (const key of keys) this.files.delete(key)
  }
}

function parseOptions(query: string): ImageTransformOptions {
  const parsed = parseImageTransform(new URLSearchParams(query))
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.value
}

function expectSuccess(result: ImageTransformResult, contentType: string): asserts result is Extract<ImageTransformResult, { ok: true }> {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  expect(result.contentType).toBe(contentType)
}

async function dimensions(result: ImageTransformResult): Promise<{ width: number; height: number }> {
  expectSuccess(result, 'image/png')
  const metadata = await new Bun.Image(result.bytes).metadata()
  return { width: metadata.width, height: metadata.height }
}

async function responseDimensions(response: Response): Promise<{ width: number; height: number }> {
  const metadata = await new Bun.Image(await response.bytes()).metadata()
  return { width: metadata.width, height: metadata.height }
}

function createBmp(width: number, height: number): Uint8Array {
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const dataSize = rowSize * height
  const bytes = new Uint8Array(54 + dataSize)
  const view = new DataView(bytes.buffer)
  bytes[0] = 0x42
  bytes[1] = 0x4d
  view.setUint32(2, bytes.length, true)
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, width, true)
  view.setInt32(22, height, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 24, true)
  view.setUint32(34, dataSize, true)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = 54 + y * rowSize + x * 3
      bytes[offset] = x * 40
      bytes[offset + 1] = y * 80
      bytes[offset + 2] = 255 - x * 30
    }
  }
  return bytes
}
