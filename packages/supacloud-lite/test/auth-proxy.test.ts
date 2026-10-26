import { describe, expect, test } from 'bun:test'
import { createExternalAuthProxy } from '../src/runtime/auth/proxy.js'

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://app.example.test${path}`, init)
}

describe('external auth proxy', () => {
  test('proxies only the fixed OAuth token, userinfo and logout paths', async () => {
    const calls: Array<{ url: string; method: string }> = []
    const proxy = createExternalAuthProxy({
      issuer: 'https://auth.example.test/auth/v1',
      fetch: async (input, init) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET' })
        return Response.json({ ok: true })
      },
    })

    expect(await proxy(request('/api/health'))).toBeNull()
    expect(await proxy(request('/auth/v1/oauth/authorize'))).toBeNull()

    const token = await proxy(request('/auth/v1/oauth/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token',
    }))
    expect(token?.status).toBe(200)
    expect(calls).toEqual([{
      url: 'https://auth.example.test/auth/v1/oauth/token?grant_type=refresh_token',
      method: 'POST',
    }])
  })

  test('rejects wrong methods and never becomes an open proxy', async () => {
    const proxy = createExternalAuthProxy({
      issuer: 'https://auth.example.test/auth/v1',
      fetch: async () => Response.json({ ok: true }),
    })
    const wrongMethod = await proxy(request('/auth/v1/oauth/token'))
    expect(wrongMethod?.status).toBe(405)
    expect(wrongMethod?.headers.get('allow')).toBe('POST')
    expect(await proxy(request('/auth/v1/admin/users'))).toBeNull()
    expect(await proxy(request('https://evil.example.test/auth/v1/oauth/token', { method: 'POST' }))).toBeNull()
  })

  test('forwards only allowlisted request headers and strips cookies and hop headers', async () => {
    let captured: Headers | undefined
    const proxy = createExternalAuthProxy({
      issuer: 'https://auth.example.test/auth/v1',
      fetch: async (_input, init) => {
        captured = new Headers(init?.headers)
        return Response.json({ sub: 'user-1' })
      },
    })
    await proxy(request('/auth/v1/oauth/userinfo', {
      headers: {
        accept: 'application/json',
        authorization: 'Bearer token',
        cookie: 'session=secret',
        'x-forwarded-for': '203.0.113.1',
      },
    }))
    expect(captured?.get('accept')).toBe('application/json')
    expect(captured?.get('authorization')).toBe('Bearer token')
    expect(captured?.has('cookie')).toBe(false)
    expect(captured?.has('x-forwarded-for')).toBe(false)
  })

  test('rejects redirects outside the identity and configured application origins', async () => {
    let mode = 'same'
    const proxy = createExternalAuthProxy({
      issuer: 'https://auth.example.test/auth/v1',
      allowedRedirectOrigins: ['https://app.example.test'],
      fetch: async () => {
        if (mode === 'same') return new Response(null, { status: 302, headers: { location: '/login' } })
        if (mode === 'app') {
          return new Response(null, { status: 302, headers: { location: 'https://app.example.test/login' } })
        }
        return new Response(null, { status: 302, headers: { location: 'https://evil.example.test/login' } })
      },
    })

    const same = await proxy(request('/auth/v1/logout', { method: 'POST' }))
    expect(same?.headers.get('location')).toBe('https://auth.example.test/login')
    mode = 'app'
    const app = await proxy(request('/auth/v1/logout', { method: 'POST' }))
    expect(app?.headers.get('location')).toBe('https://app.example.test/login')
    mode = 'evil'
    const rejected = await proxy(request('/auth/v1/logout', { method: 'POST' }))
    expect(rejected?.status).toBe(502)
    expect(rejected?.headers.has('location')).toBe(false)
  })

  test('fails closed when the identity service is unavailable', async () => {
    const proxy = createExternalAuthProxy({
      issuer: 'https://auth.example.test/auth/v1',
      fetch: async () => { throw new Error('offline') },
    })
    const response = await proxy(request('/auth/v1/oauth/token', { method: 'POST' }))
    expect(response?.status).toBe(503)
    expect(await response?.json()).toMatchObject({ code: 'AUTH_PROXY_UNAVAILABLE' })
  })

  test('validates issuer and redirect origins before serving', () => {
    for (const issuer of [
      'http://auth.example.test/auth/v1',
      'https://auth.example.test/oauth',
      'https://user:pass@auth.example.test/auth/v1',
    ]) {
      expect(() => createExternalAuthProxy({ issuer })).toThrow()
    }
    expect(() => createExternalAuthProxy({
      issuer: 'https://auth.example.test/auth/v1',
      allowedRedirectOrigins: ['http://app.example.test'],
    })).toThrow()
  })
})
