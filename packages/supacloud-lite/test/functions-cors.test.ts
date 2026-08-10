import { expect, test } from 'bun:test'
import { createBackend } from '../src/runtime/index.js'

test('delegates function preflights while keeping default CORS for non-function routes', async () => {
  const functionOrigin = 'https://app.example'
  const observedMethods: string[] = []
  const backend = await createBackend({
    startRuntimeServices: false,
    log: () => {},
    functions: new Map([
      [
        'cors-owned',
        (request) => {
          observedMethods.push(request.method)
          if (request.headers.get('origin') !== functionOrigin) {
            return new Response(null, { status: 403 })
          }
          return new Response(null, {
            status: 204,
            headers: {
              'access-control-allow-origin': functionOrigin,
              'access-control-allow-methods': 'POST, OPTIONS',
            },
          })
        },
      ],
    ]),
  })
  const requestFunctionPreflight = (origin: string) =>
    backend.fetch(
      new Request('http://localhost/functions/v1/cors-owned', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST' },
      })
    )

  try {
    const functionPreflight = await requestFunctionPreflight(functionOrigin)
    expect(observedMethods).toEqual(['OPTIONS'])
    expect(functionPreflight.status).toBe(204)
    expect(functionPreflight.headers.get('access-control-allow-origin')).toBe(functionOrigin)
    expect(functionPreflight.headers.get('access-control-allow-headers')).toBeNull()

    const rejectedPreflight = await requestFunctionPreflight('https://evil.example')
    expect(observedMethods).toEqual(['OPTIONS', 'OPTIONS'])
    expect(rejectedPreflight.status).toBe(403)
    expect(rejectedPreflight.headers.get('access-control-allow-origin')).toBeNull()

    const restPreflight = await backend.fetch(
      new Request('http://localhost/rest/v1/todos', {
        method: 'OPTIONS',
        headers: { origin: functionOrigin, 'access-control-request-method': 'POST' },
      })
    )
    expect(restPreflight.status).toBe(204)
    expect(restPreflight.headers.get('access-control-allow-origin')).toBe('*')
    expect(restPreflight.headers.get('access-control-allow-methods')).toContain('POST')
  } finally {
    await backend.close()
  }
})
