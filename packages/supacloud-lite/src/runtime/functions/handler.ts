/**
 * Edge Functions (/functions/v1/*) - supabase.functions.invoke() support.
 *
 * A "function" is any fetch handler: (Request) => Response | Promise<Response>.
 * Framework router objects (Elysia `app.handle()`, Hono `app.fetch()`) are
 * supported too, aligned with the SupaCloud Edge Runtime contract: route-aware
 * handlers receive a function-local URL (`/functions/v1/<name>/a/b` -> `/a/b`).
 * The core takes a name → handler map (portable, works in the browser); the
 * Node CLI populates it from supabase/functions/<name>/index.{ts,js,mjs}
 * modules that `export default` a handler.
 */
import type { RequestContext } from '../types.js'
import { runWithDenoEnv } from './deno-shim.js'
import { runWithBackgroundTasks } from './edge-runtime-shim.js'
import { runWithFetchPolicy } from './fetch-policy.js'
import { type PgredisCache, runWithPgredisCache } from './pgredis.js'

/** An edge function: a fetch handler invoked with the resolved request context. */
export type EdgeFunction = (req: Request, ctx: FunctionContext) => Response | Promise<Response>

/** Frameworks whose router objects own the path below /functions/v1/<name>. */
export type FunctionFramework = 'fetch' | 'elysia' | 'hono'

/**
 * A framework router export, e.g. an Elysia instance (`handle()`) or a Hono /
 * Itty router (`fetch()`). Object handlers receive only the Request.
 */
export interface FrameworkObjectHandler {
  handle?: (req: Request) => Response | Promise<Response>
  fetch?: (req: Request) => Response | Promise<Response>
  /** Router route table (Elysia exposes one); marks the handler route-aware. */
  routes?: unknown
  /** Explicit marker emitted by framework adapters. */
  __supacloud?: { routeAware?: boolean }
}

/** Anything registerable as a function: plain fetch handler or router object. */
export type FunctionHandler = EdgeFunction | FrameworkObjectHandler

/**
 * Per-invocation resource limits, aligned with the Edge Runtime Manifest v2
 * `limits` block (timeout_ms / max_request_body_bytes /
 * max_response_body_bytes / wait_until_timeout_ms). Lite defaults to no
 * limit when undeclared; production caps at 900s / 30MB.
 */
export interface FunctionLimits {
  /** limits.timeout_ms: max wall time per invocation; on expiry the request is aborted and a 504 returned. */
  timeoutMs?: number
  /** limits.max_request_body_bytes: max inbound body size; oversized bodies get a 413. */
  maxRequestBodyBytes?: number
  /** limits.max_response_body_bytes: max outbound body size; oversized responses get a 502 / cut stream. */
  maxResponseBodyBytes?: number
  /** limits.wait_until_timeout_ms: max time to wait for EdgeRuntime.waitUntil tasks after the response. */
  waitUntilTimeoutMs?: number
}

/**
 * Declared capabilities, aligned with the Edge Runtime Manifest v2
 * `capabilities` block (secrets / outbound_hosts / background). Undeclared
 * means unrestricted (back-compat).
 */
export interface FunctionCapabilities {
  /** capabilities.secrets: env keys (beyond the SUPABASE_* base trio) visible to the function. */
  secrets?: string[]
  /** capabilities.outbound_hosts: exact fetch host allowlist (no port); loopback is always allowed. */
  outboundHosts?: string[]
  /**
   * capabilities.background: whether EdgeRuntime.waitUntil is enabled. Lite
   * defaults to allowed (local back-compat); only an explicit `false` takes
   * the production error path.
   */
  background?: boolean
}

/** A loaded function plus its declared framework profile, limits, and capabilities. */
export interface LoadedFunction {
  handler: FunctionHandler
  /** config.toml [functions.<name>].framework; `fetch` keeps legacy routing. */
  framework?: FunctionFramework
  /** config.toml [functions.<name>] timeout_ms / max_request_body_bytes / max_response_body_bytes / wait_until_timeout_ms. */
  limits?: FunctionLimits
  /** config.toml [functions.<name>] secrets / outbound_hosts / background. */
  capabilities?: FunctionCapabilities
}

/** Registry value: a bare handler or a {@link LoadedFunction} entry. */
export type FunctionRegistryValue = FunctionHandler | LoadedFunction

/** Header written only after Lite has verified the request JWT. */
export const VERIFIED_JWT_SUBJECT_HEADER = 'x-supacloud-jwt-sub'

const UNSAFE_VERIFIED_JWT_SUBJECT = /[\u0000-\u001F\u007F-\u009F\u0100-\u{10FFFF}]/u

function verifiedSubject(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024) return null
  if (value.trim() !== value || UNSAFE_VERIFIED_JWT_SUBJECT.test(value)) return null
  return value
}

/**
 * Client values are never trusted. A verified JWT subject is forwarded only
 * after the request has passed the backend's JWT verification step.
 */
function withVerifiedJwtSubject(request: Request, ctx: RequestContext): Request {
  const trustedRequest = request.clone()
  trustedRequest.headers.delete(VERIFIED_JWT_SUBJECT_HEADER)
  const subject = verifiedSubject(ctx.claims?.sub)
  if (subject !== null) trustedRequest.headers.set(VERIFIED_JWT_SUBJECT_HEADER, subject)
  return trustedRequest
}

/** Second argument passed to every {@link EdgeFunction} invocation. */
export interface FunctionContext {
  /** verified request context (role + JWT claims) resolved by the router */
  auth: RequestContext
  /** keys/urls so the function can create its own supabase-js client, plus any secrets loaded from supabase/functions/.env */
  env: {
    SUPABASE_URL: string
    SUPABASE_ANON_KEY: string
    SUPABASE_SERVICE_ROLE_KEY: string
    [key: string]: string
  }
}

function isLoadedFunction(value: FunctionRegistryValue): value is LoadedFunction {
  return typeof value === 'object' && value !== null && 'handler' in value
}

function normalizeEntry(value: FunctionRegistryValue): LoadedFunction {
  return isLoadedFunction(value) ? value : { handler: value }
}

/** Mirrors the Edge Runtime: router objects and marked handlers own sub-paths. */
export function isFrameworkRouterHandler(handler: unknown): boolean {
  if (!handler || typeof handler !== 'object') return false
  const candidate = handler as FrameworkObjectHandler
  if (candidate.__supacloud?.routeAware === true) return true
  if (typeof candidate.handle === 'function') return true
  return Array.isArray(candidate.routes) && typeof candidate.fetch === 'function'
}

/**
 * Strip the function prefix so framework routers see their own route table:
 * /functions/v1/<name>/a/b -> /a/b (and /functions/v1/<name> -> /).
 * Matches the Edge Runtime's toFunctionLocalUrl().
 */
export function toFunctionLocalUrl(requestUrl: string): string {
  const url = new URL(requestUrl)
  const publicRoute = url.pathname.match(/^\/functions\/v1\/[^/]+(\/.*)?$/)
  if (publicRoute) {
    url.pathname = publicRoute[1] || '/'
    return url.toString()
  }
  const internalRoute = url.pathname.match(/^\/[^/]+(\/.*)?$/)
  if (internalRoute) {
    url.pathname = internalRoute[1] || '/'
  }
  return url.toString()
}

/** Registry and dispatcher for edge functions, backing supabase.functions.invoke(). */
export class FunctionsHandler {
  constructor(
    private functions: Map<string, FunctionRegistryValue>,
    private env: FunctionContext['env'],
    private pgredis: PgredisCache
  ) {}

  /** Register (or replace) a function under `name`, served at /functions/v1/<name>. */
  register(name: string, fn: FunctionRegistryValue): void {
    this.functions.set(name, fn)
  }

  /** Names of all registered functions. */
  list(): string[] {
    return [...this.functions.keys()]
  }

  /**
   * Dispatch a /functions/v1/<name> request to its handler, returning a 404 when
   * unknown and a 500 when the handler throws or returns a non-Response.
   * Declared limits/capabilities are enforced in order: request body size (413),
   * invocation timeout (504), outbound host allowlist, secrets allowlist,
   * EdgeRuntime.waitUntil background scope, response body size (502).
   */
  async handle(req: Request, ctx: RequestContext, url: URL): Promise<Response> {
    const name = url.pathname.replace(/^\/functions\/v1\/?/, '').split('/')[0]
    if (!name) {
      return json(404, { error: 'function name required: /functions/v1/<name>' })
    }
    const value = this.functions.get(name)
    if (!value) {
      return json(404, { error: `function "${name}" not found` })
    }
    const entry = normalizeEntry(value)
    const limits = entry.limits
    const capabilities = entry.capabilities

    // 1. Request body limit. A declared content-length is checked up front;
    // a chunked/lengthless body is counted while streaming below.
    const maxBody = limits?.maxRequestBodyBytes
    let request = req
    if (maxBody !== undefined) {
      const contentLength = req.headers.get('content-length')
      if (contentLength !== null && Number(contentLength) > maxBody) {
        return json(413, { error: `function "${name}" request body exceeded ${maxBody} bytes` })
      }
      if (contentLength === null && req.body) {
        request = withCountedBody(request, maxBody)
      }
    }

    const routeAware =
      (entry.framework !== undefined && entry.framework !== 'fetch') ||
      isFrameworkRouterHandler(entry.handler)
    request = withVerifiedJwtSubject(request, ctx)
    if (routeAware) request = new Request(toFunctionLocalUrl(request.url), request)

    // 2. Invocation timeout: the abort signal rides on the forwarded Request so
    // a cooperative handler (or its body reads) can cancel early.
    const timeoutMs = limits?.timeoutMs
    const abort = timeoutMs !== undefined ? new AbortController() : undefined
    if (abort) request = withSignal(request, abort.signal)
    try {
      // 4. Secrets allowlist: the function sees the SUPABASE_* base trio plus
      // only the declared secret keys - both via Deno.env and ctx.env.
      const env = capabilities?.secrets ? filterSecretsEnv(this.env, capabilities.secrets) : this.env
      // Bind Deno.env to this backend's function env for the call so a
      // Deno.serve/Deno.env-style function reads its own secrets, not another
      // backend's or the host process.env.
      const invoke = () => this.invoke(entry.handler, request, ctx, env)
      const inner = () => runWithDenoEnv(env, () => runWithPgredisCache(this.pgredis, invoke))
      // 3. Outbound host allowlist; undeclared means fetch is not wrapped at all.
      const run = capabilities?.outboundHosts
        ? () => runWithFetchPolicy(capabilities.outboundHosts!, inner)
        : inner
      // 5. EdgeRuntime.waitUntil scope. Always installed (ALS overhead is
      // negligible) so the lite default of allowing background tasks holds;
      // an explicit capabilities.background=false gates waitUntil like
      // production, and waitUntilTimeoutMs caps the post-response flush.
      const invokeWithBackground = () =>
        runWithBackgroundTasks(
          { allowed: capabilities?.background !== false, timeoutMs: limits?.waitUntilTimeoutMs },
          run
        )
      const res =
        timeoutMs !== undefined
          ? await this.withTimeout(name, timeoutMs, invokeWithBackground, abort!)
          : await invokeWithBackground()
      if (!(res instanceof Response)) {
        return json(500, { error: `function "${name}" did not return a Response` })
      }
      // 6. Response body limit: declared content-length is checked up front;
      // a streamed body is counted while streaming to the client.
      const maxResponse = limits?.maxResponseBodyBytes
      return maxResponse !== undefined ? withResponseLimit(name, res, maxResponse) : res
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return json(500, { error: message })
    }
  }

  /** Race the invocation against `timeoutMs`; on timeout abort the request and answer 504. */
  private async withTimeout(
    name: string,
    timeoutMs: number,
    run: () => Promise<Response>,
    abort: AbortController
  ): Promise<Response> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const pending = run()
    try {
      const winner = await Promise.race([
        pending.then((res) => ({ timedOut: false as const, res })),
        new Promise<{ timedOut: true }>((resolve) => {
          timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
        }),
      ])
      if (winner.timedOut) {
        abort.abort()
        // the handler may still settle after the timeout; swallow its late
        // result/rejection so it never surfaces as an unhandled rejection
        pending.then(() => {}, () => {})
        return json(504, { error: `function "${name}" timed out after ${timeoutMs}ms` })
      }
      return winner.res
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private invoke(
    handler: FunctionHandler,
    req: Request,
    ctx: RequestContext,
    env: FunctionContext['env']
  ): Promise<Response> {
    if (typeof handler === 'function') {
      return Promise.resolve(handler(req, { auth: ctx, env }))
    }
    if (typeof handler.handle === 'function') {
      return Promise.resolve(handler.handle.call(handler, req))
    }
    if (typeof handler.fetch === 'function') {
      return Promise.resolve(handler.fetch.call(handler, req))
    }
    throw new Error('function handler must be a function or an object with handle()/fetch()')
  }
}

/** The base env every function sees; declared secrets are added on top. */
const BASE_ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const

/** Base trio + declared secret keys only (Manifest v2 capabilities.secrets). */
function filterSecretsEnv(env: FunctionContext['env'], secrets: string[]): FunctionContext['env'] {
  const out: Record<string, string> = {}
  for (const key of BASE_ENV_KEYS) out[key] = env[key]
  for (const key of secrets) {
    if (env[key] !== undefined) out[key] = env[key]
  }
  return out as FunctionContext['env']
}

/**
 * Count a lengthless (chunked) request body against `limit`. On overflow the
 * stream errors, so the handler's body read rejects and surfaces as a 500 -
 * once the body is streaming in, there is no way to turn it into a clean 413.
 */
function withCountedBody(req: Request, limit: number): Request {
  let seen = 0
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength
      if (seen > limit) {
        controller.error(new Error(`request body exceeded ${limit} bytes`))
        return
      }
      controller.enqueue(chunk)
    },
  })
  // `duplex: 'half'` is required when the body is a stream (undici; harmless in Bun).
  return new Request(req, { body: req.body!.pipeThrough(counter), duplex: 'half' } as RequestInit)
}

/**
 * Enforce limits.max_response_body_bytes on a function response. A declared
 * content-length over the limit is replaced with a clean 502 up front (the
 * production FunctionResponseLimitError -> 502 path). Otherwise the body is
 * counted while streaming; on overflow the stream errors, so the client sees
 * a cut-off body after an already-committed status line - the local
 * equivalent of production's reader.cancel(), since the status line can no
 * longer be rewritten mid-stream.
 */
function withResponseLimit(name: string, res: Response, limit: number): Response {
  const contentLength = res.headers.get('content-length')
  if (contentLength !== null && Number(contentLength) > limit) {
    return json(502, { error: `function "${name}" response exceeded ${limit} bytes` })
  }
  if (!res.body) return res
  let seen = 0
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength
      if (seen > limit) {
        controller.error(new Error(`function "${name}" response exceeded ${limit} bytes`))
        return
      }
      controller.enqueue(chunk)
    },
  })
  return new Response(res.body.pipeThrough(counter), res)
}

/** Clone a request carrying an abort signal (Bun accepts `new Request(req, { signal })`). */
function withSignal(req: Request, signal: AbortSignal): Request {
  return new Request(req, { signal, ...(req.body ? { duplex: 'half' } : {}) } as RequestInit)
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
