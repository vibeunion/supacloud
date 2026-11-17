import { afterEach, describe, expect, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { createLiteBackend, type SupaCloudLiteBackend } from '../src/index.js'
import { CAPTCHA_GLYPHS } from '../src/runtime/auth/captcha.js'

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
  const svg = decodeURIComponent(body.image.slice(body.image.indexOf(',') + 1))
  const reverseGlyphs = new Map(Object.entries(CAPTCHA_GLYPHS).map(([character, glyph]) => [glyph.join(''), character]))
  const answer = [...svg.matchAll(/<g class="captcha-glyph"[^>]*>([\s\S]*?)<\/g>/g)].map((match, index) => {
    const pixels = new Set([...match[1].matchAll(/<rect x="(\d+)" y="(\d+)"/g)].map((pixel) => `${pixel[1]}:${pixel[2]}`))
    const originX = 18 + index * 34
    const originY = 11
    const glyph = Array.from({ length: 7 }, (_, row) =>
      Array.from({ length: 5 }, (_, column) => pixels.has(`${originX + column * 4}:${originY + row * 4}`) ? '1' : '0').join('')
    ).join('')
    return reverseGlyphs.get(glyph) ?? ''
  }).join('')
  expect(answer).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/)
  return { id: body.id, answer }
}

describe('local CAPTCHA', () => {
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
