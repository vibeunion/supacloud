import { describe, expect, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { createLiteBackend } from '../src/index.js'
import {
  parseImageTransform,
  transformImage,
  type ImageTransformOptions,
  type ImageTransformResult,
} from '../src/vendor/tinbase/storage/image-transform.js'
import { StorageHandler } from '../src/vendor/tinbase/storage/handler.js'

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

  test('preserves cache control and sets transformed response headers', async () => {
    const handler = new StorageHandler(null as never, null as never, { jwtSecret: 'test' })
    const transformResponse = (
      handler as unknown as {
        transformImageResponse(source: Response, url: URL, head: boolean): Promise<Response>
      }
    ).transformImageResponse.bind(handler)
    const source = () =>
      new Response(sourcePng as BodyInit, {
        headers: {
          'cache-control': 'public, max-age=3600',
          'content-disposition': 'attachment',
          'content-type': 'image/png',
        },
      })
    const url = new URL('http://localhost/storage/v1/render/image/public/bucket/image.png?width=8&format=webp')

    const response = await transformResponse(source(), url, false)
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(response.headers.get('content-type')).toBe('image/webp')
    expect(response.headers.get('content-length')).toBe(String((await response.clone().arrayBuffer()).byteLength))
    expect(response.headers.has('content-disposition')).toBe(false)

    const head = await transformResponse(source(), url, true)
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
})

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
