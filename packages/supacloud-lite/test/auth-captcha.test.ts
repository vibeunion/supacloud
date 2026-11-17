import { afterEach, describe, expect, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { createLiteBackend, type SupaCloudLiteBackend } from '../src/index.js'
import { CAPTCHA_GLYPHS } from '../src/runtime/auth/captcha.js'
import { applyAuthSettingsPatch, DEFAULT_AUTH_SETTINGS } from '../src/runtime/auth/settings.js'

const backends: SupaCloudLiteBackend[] = []

afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.close()))
})

function clientFor(backend: SupaCloudLiteBackend) {
  return createClient('http://local', backend.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: backend.fetch },
  })
}

async function challengeFor(backend: SupaCloudLiteBackend): Promise<{ id: string; answer: string }> {
  const response = await backend.fetch('http://local/auth/v1/captcha/challenge', {
    headers: { apikey: backend.anonKey },
  })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const body = await response.json() as { id: string; image: string }
  const imageBytes = Uint8Array.from(atob(body.image.slice('data:image/png;base64,'.length)), (character) => character.charCodeAt(0))
  const view = new DataView(imageBytes.buffer)
  expect([...imageBytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  const compressed: number[] = []
  let offset = 8
  while (offset < imageBytes.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...imageBytes.subarray(offset + 4, offset + 8))
    if (type === 'IDAT') compressed.push(...imageBytes.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
  }
  const inflated: number[] = []
  let compressedOffset = 2
  while (compressedOffset < compressed.length - 4) {
    const header = compressed[compressedOffset] ?? 0
    const length = (compressed[compressedOffset + 1] ?? 0) | ((compressed[compressedOffset + 2] ?? 0) << 8)
    expect((header >> 1) & 3).toBe(0)
    inflated.push(...compressed.slice(compressedOffset + 5, compressedOffset + 5 + length))
    compressedOffset += 5 + length
    if (header & 1) break
  }
  const pixels = new Uint8Array(width * height * 4)
  const stride = width * 4 + 1
  for (let row = 0; row < height; row += 1) {
    expect(inflated[row * stride]).toBe(0)
    pixels.set(inflated.slice(row * stride + 1, row * stride + stride), row * width * 4)
  }
  const isDark = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false
    const pixel = (y * width + x) * 4
    return (pixels[pixel + 3] ?? 0) > 200 && (pixels[pixel] ?? 255) < 80
  }
  const reverseGlyphs = new Map(Object.entries(CAPTCHA_GLYPHS).map(([character, glyph]) => [glyph.join(''), character]))
  const answer = Array.from({ length: 5 }, (_, index) => {
    const originX = 15 + index * 35
    const originY = 10
    const glyph = Array.from({ length: 7 }, (_, row) =>
      Array.from({ length: 5 }, (_, column) => isDark(originX + column * 4 + 1, originY + row * 4 + 1) ? '1' : '0').join('')
    ).join('')
    return reverseGlyphs.get(glyph) ?? ''
  }).join('')
  expect(answer).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/)
  return { id: body.id, answer }
}

describe('local CAPTCHA', () => {
  test('validates runtime CAPTCHA settings without throwing', () => {
    const settings = { ...DEFAULT_AUTH_SETTINGS }
    expect(applyAuthSettingsPatch(settings, {
      captchaProvider: 'local',
      captchaChallengeTtlSeconds: 240,
      captchaMaxAttempts: 7,
    })).toBeNull()
    expect(settings).toMatchObject({
      captchaProvider: 'local',
      captchaChallengeTtlSeconds: 240,
      captchaMaxAttempts: 7,
    })
  })

  test('advertises the local challenge endpoint and blocks OTP issuance without a token', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      authSettings: { captchaProvider: 'local', smsOtpCooldownSeconds: 0 },
      log: () => {},
    })
    backends.push(backend)
    const settings = await backend.fetch('http://local/auth/v1/settings', {
      headers: { apikey: backend.anonKey },
    })
    expect(await settings.json()).toMatchObject({
      captcha: {
        enabled: true,
        provider: 'local',
        challenge_endpoint: '/auth/v1/captcha/challenge',
      },
    })

    const result = await clientFor(backend).auth.signInWithOtp({ phone: '+8613800138000' })
    expect(result.error?.code).toBe('captcha_required')
    expect(backend.smsInbox?.list()).toHaveLength(0)
  })

  test('accepts one challenge token and rejects replay', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      authSettings: { captchaProvider: 'local', smsOtpCooldownSeconds: 0 },
      log: () => {},
    })
    backends.push(backend)
    const captcha = await challengeFor(backend)
    const client = clientFor(backend)
    const options = { captchaToken: `${captcha.id}.${captcha.answer}` }

    const sent = await client.auth.signInWithOtp({ phone: '+8613800138000', options })
    expect(sent.error).toBeNull()
    expect(backend.smsInbox?.list()).toHaveLength(1)

    const replay = await client.auth.signInWithOtp({
      phone: '+8613800138001',
      options,
    })
    expect(replay.error?.code).toBe('captcha_failed')
    expect(backend.smsInbox?.list()).toHaveLength(1)
  })

  test('retires a challenge after repeated wrong answers', async () => {
    const backend = await createLiteBackend({
      jwtSecret: 'x'.repeat(64),
      vaultKey: 'y'.repeat(64),
      authSettings: { captchaProvider: 'local', captchaMaxAttempts: 2, smsOtpCooldownSeconds: 0 },
      log: () => {},
    })
    backends.push(backend)
    const captcha = await challengeFor(backend)
    const client = clientFor(backend)
    const wrongAnswer = captcha.answer === '23456' ? '23457' : '23456'
    const wrongToken = `${captcha.id}.${wrongAnswer}`
    expect((await client.auth.signInWithOtp({ phone: '+8613800138002', options: { captchaToken: wrongToken } })).error?.code)
      .toBe('captcha_failed')
    expect((await client.auth.signInWithOtp({ phone: '+8613800138003', options: { captchaToken: wrongToken } })).error?.code)
      .toBe('captcha_failed')
    expect((await client.auth.signInWithOtp({
      phone: '+8613800138004',
      options: { captchaToken: `${captcha.id}.${captcha.answer}` },
    })).error?.code).toBe('captcha_failed')
  })
})
