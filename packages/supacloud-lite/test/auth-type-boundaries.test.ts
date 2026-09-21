import { describe, expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import { decodeJwt, verifyJwt } from '../src/runtime/jwt.js'
import { qrSvgDataUri } from '../src/runtime/auth/qr.js'
import { RateLimiter } from '../src/runtime/auth/rate-limit.js'

const secret = 'synthetic-jwt-boundary-key'
function signedPayload(payload: unknown, header: unknown = { alg: 'HS256', typ: 'JWT' }): string {
  const text = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
  return `${text}.${createHmac('sha256', secret).update(text).digest('base64url')}`
}

describe('JWT claim types', () => {
  test.each([
    null, [], 'not-claims', { sub: 1 }, { role: false }, { aud: {} },
    { exp: '0' }, { exp: null }, { iat: [] }, { nbf: '0' },
    { amr: {} }, { amr: [null] }, { amr: [{ method: 'totp', timestamp: '0' }] },
  ].map((payload) => ({ payload })))('rejects signed payloads that violate declared claim types: %j', async ({ payload }) => {
    const token = signedPayload(payload)
    expect(decodeJwt(token)).toBeNull()
    expect(await verifyJwt(token, secret)).toBeNull()
  })

  test('preserves well-typed claims and domain-owned extension values', async () => {
    const claims = {
      sub: 'test-user', role: 'authenticated', aud: 'authenticated', exp: 4_102_444_800,
      amr: [{ method: 'totp', timestamp: 1_700_000_000 }],
      application: { permissions: ['read'] },
    }
    const token = signedPayload(claims)
    expect(decodeJwt(token)).toEqual(claims)
    expect(await verifyJwt(token, secret)).toEqual(claims)
    expect(await verifyJwt(token, 'wrong-key')).toBeNull()
  })

  test('rejects expired and not-yet-active tokens and unsupported headers', async () => {
    expect(await verifyJwt(signedPayload({ exp: 0 }), secret)).toBeNull()
    expect(await verifyJwt(signedPayload({ nbf: Date.now() / 1000 + 60 }), secret)).toBeNull()
    expect(await verifyJwt(signedPayload({}, null), secret)).toBeNull()
    expect(await verifyJwt(signedPayload({}, { alg: 'none' }), secret)).toBeNull()
    for (const token of ['', 'a.b', 'a..b', '.a.b', 'a.b.', 'a.b.c.d']) {
      expect(await verifyJwt(token, secret)).toBeNull()
    }
  })
})

describe('MFA QR indexing regression', () => {
  // Snapshots from the pre-hardening implementation, not independent QR conformance evidence.
  test.each([
    [0, '940b853ec62baac9043ce3f92638b92322e671ba523edf12c8ce5384311988e4'],
    [1, 'de0a6ec0450b4d518ecfd4d19b752e4408bf81fbe73932db05c2feb05d43b004'],
    [14, 'f26456015bd0bbdc5f639f642a9524a154288cc0ce54c6fe5fe8b8de4dc38e3c'],
    [15, '423dc44d9068a1f5631fdf4fe2fc4e0cc2ba5de1fac8e504743ab8d8e3482f2f'],
    [100, '22ad37cb1ac6a218a1f3038df021c477fd372ab400ffb4c504e22e5c9dada877'],
    [250, '400009fea9d881b10bcb849f23dc0bc9ee3ec74599c8f198b3c4405fe04bc759'],
    [1000, '40ec1f32ae2d66eccfe829cd00f7598a65fcfc8b1dc6e89aea6adb02ad4a8ab1'],
    [2000, '177185b6341ee1b3678d05b19b732f5d8d4be0bb9c787aa183e31a999e052c9a'],
  ] as const)('preserves the output for %i bytes', (length, hash) => {
    expect(createHash('sha256').update(qrSvgDataUri('x'.repeat(length))).digest('hex')).toBe(hash)
  })

  test('rejects input exceeding the supported capacity', () => {
    expect(() => qrSvgDataUri('x'.repeat(10_000))).toThrow('QR data too long')
  })
})

describe('Auth rate-limit configuration', () => {
  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid limits and windows %s', (value) => {
    expect(() => new RateLimiter({ token: { limit: value, windowMs: 1000 } })).toThrow('positive safe integer')
    expect(() => new RateLimiter({ token: { limit: 1, windowMs: value } })).toThrow('positive safe integer')
  })

  test('permits the first attempt, reports a finite retry and expires the window', () => {
    const limiter = new RateLimiter({ token: { limit: 1, windowMs: 1000 } })
    try {
      expect(limiter.check('token', 'test-client', 1000)).toBeNull()
      expect(limiter.check('token', 'test-client', 1001)).toBe(1)
      expect(limiter.check('token', 'test-client', 2000)).toBeNull()
    } finally {
      limiter.stop()
    }
  })
})
