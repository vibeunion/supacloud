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

/** A loaded function plus its declared framework profile. */
export interface LoadedFunction {
  handler: FunctionHandler
  /** config.toml [functions.<name>].framework; `fetch` keeps legacy routing. */
  framework?: FunctionFramework
}

/** Registry value: a bare handler or a {@link LoadedFunction} entry. */
export type FunctionRegistryValue = FunctionHandler | LoadedFunction

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

  /** Dispatch a /functions/v1/<name> request to its handler, returning a 404 when unknown and a 500 when the handler throws or returns a non-Response. */
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
    const routeAware =
      (entry.framework !== undefined && entry.framework !== 'fetch') ||
      isFrameworkRouterHandler(entry.handler)
    const target = routeAware ? new Request(toFunctionLocalUrl(req.url), req) : req
    try {
      // Bind Deno.env to this backend's function env for the call so a
      // Deno.serve/Deno.env-style function reads its own secrets, not another
      // backend's or the host process.env.
      const invoke = () => this.invoke(entry.handler, target, ctx)
      const res = await runWithDenoEnv(this.env, () => runWithPgredisCache(this.pgredis, invoke))
      if (!(res instanceof Response)) {
        return json(500, { error: `function "${name}" did not return a Response` })
      }
      return res
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return json(500, { error: message })
    }
  }

  private invoke(handler: FunctionHandler, req: Request, ctx: RequestContext): Promise<Response> {
    if (typeof handler === 'function') {
      return Promise.resolve(handler(req, { auth: ctx, env: this.env }))
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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
