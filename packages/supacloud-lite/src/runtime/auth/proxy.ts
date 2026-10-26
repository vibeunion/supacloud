/**
 * Same-origin reverse proxy for an external SupAuth / GoTrue OAuth runtime.
 *
 * Browser applications often run on a business origin that the identity
 * service does not allow via CORS. The authorization request is a top-level
 * navigation and needs no proxy; token exchange, userinfo and logout are
 * browser API calls and can be routed through this handler instead.
 *
 * This is deliberately not a general-purpose proxy: only exact OAuth paths and
 * methods are accepted, the upstream origin is fixed by configuration, and
 * credentials, cookies and hop-by-hop headers are never forwarded.
 */

const ALLOWED_ROUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  '/auth/v1/oauth/token': new Set(['POST']),
  '/auth/v1/oauth/userinfo': new Set(['GET']),
  '/auth/v1/logout': new Set(['GET', 'POST']),
}

const FORWARD_REQUEST_HEADERS = ['accept', 'authorization', 'content-type', 'apikey'] as const
const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'cache-control',
  'retry-after',
  'www-authenticate',
] as const

export type ExternalAuthFetch = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>

export interface ExternalAuthProxyOptions {
  /** Issuer URL, for example https://auth.example.com/auth/v1. */
  issuer: string
  /** Extra origins allowed as logout redirect targets, such as the application origin. */
  allowedRedirectOrigins?: readonly string[]
  /** Trusted host override for tests. */
  fetch?: ExternalAuthFetch
}

export type ExternalAuthProxy = (request: Request) => Promise<Response | null>

function proxyError(status: number, code: string, message: string, allow?: string): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  if (allow) headers.set('allow', allow)
  return new Response(JSON.stringify({ code, message }), { status, headers })
}

function upstreamBase(issuer: string): URL {
  let url: URL
  try {
    url = new URL(issuer)
  } catch {
    throw new TypeError('External auth issuer must be an absolute URL')
  }
  const loopback = url.hostname === '127.0.0.1'
    || url.hostname === 'localhost'
    || url.hostname === '[::1]'
    || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new TypeError('External auth issuer must use HTTPS (HTTP is allowed only on loopback)')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError('External auth issuer must not contain credentials, query or fragment')
  }
  if (url.pathname.replace(/\/+$/, '') !== '/auth/v1') {
    throw new TypeError('External auth issuer must end with /auth/v1')
  }
  return url
}

function redirectOrigins(base: URL, extra: readonly string[] = []): Set<string> {
  const origins = new Set([base.origin])
  for (const value of extra) {
    let origin: URL
    try {
      origin = new URL(value)
    } catch {
      throw new TypeError('External auth redirect origin must be an absolute URL')
    }
    const loopback = origin.hostname === '127.0.0.1'
      || origin.hostname === 'localhost'
      || origin.hostname === '[::1]'
      || origin.hostname === '::1'
    if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback)) {
      throw new TypeError('External auth redirect origin must use HTTPS (HTTP is allowed only on loopback)')
    }
    if (origin.username || origin.password || origin.search || origin.hash) {
      throw new TypeError('External auth redirect origin must not contain credentials, query or fragment')
    }
    origins.add(origin.origin)
  }
  return origins
}

/**
 * Create a request handler that returns `null` for requests it does not own, so
 * the caller can continue normal Lite routing.
 */
export function createExternalAuthProxy(options: ExternalAuthProxyOptions): ExternalAuthProxy {
  const base = upstreamBase(options.issuer)
  const allowedRedirects = redirectOrigins(base, options.allowedRedirectOrigins)
  const fetcher = options.fetch ?? globalThis.fetch
  if (typeof fetcher !== 'function') throw new TypeError('External auth proxy requires fetch')

  return async (request: Request): Promise<Response | null> => {
    const source = new URL(request.url)
    const methods = ALLOWED_ROUTES[source.pathname]
    if (!methods) return null
    if (!methods.has(request.method)) {
      return proxyError(405, 'AUTH_PROXY_METHOD_NOT_ALLOWED', 'Auth proxy method is not allowed', [...methods].join(', '))
    }

    const target = new URL(source.pathname + source.search, base.origin)
    const headers = new Headers()
    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = request.headers.get(name)
      if (value !== null) headers.set(name, value)
    }
    const body = request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : await request.arrayBuffer()

    let upstream: Response
    try {
      upstream = await fetcher(target, {
        method: request.method,
        headers,
        body,
        redirect: 'manual',
      })
    } catch {
      return proxyError(503, 'AUTH_PROXY_UNAVAILABLE', 'Identity service is temporarily unavailable')
    }

    const responseHeaders = new Headers()
    for (const name of FORWARD_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name)
      if (value !== null) responseHeaders.set(name, value)
    }
    const location = upstream.headers.get('location')
    if (location !== null) {
      const resolved = new URL(location, base.origin)
      if (!allowedRedirects.has(resolved.origin)) {
        return proxyError(502, 'AUTH_PROXY_REDIRECT_REJECTED', 'Identity service redirect was rejected')
      }
      responseHeaders.set('location', resolved.href)
    }
    responseHeaders.set('cache-control', 'no-store')
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
  }
}