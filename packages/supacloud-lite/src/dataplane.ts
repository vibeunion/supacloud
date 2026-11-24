/**
 * The Data API process surface: `/rest/v1/*` served over an existing project
 * database.
 *
 * This is the PostgREST replacement surface. It deliberately serves the REST
 * contract only — auth, storage, functions and realtime keep their own
 * processes — so a tenant can move between data planes without bringing a
 * second full runtime, and without changing the client protocol that
 * `@supabase/supabase-js` already speaks.
 *
 * Enforcement stays layered exactly as it is today:
 *   1. the verified JWT selects a PostgreSQL role (`anon`, `authenticated`,
 *      `service_role`) and publishes `request.jwt.claims`;
 *   2. PostgreSQL grants and RLS decide what that role may read or write.
 * The data plane never connects as a bypass role to "make policies work".
 */

import { Database } from './runtime/db/database.js'
import { RestHandler } from './runtime/rest/handler.js'
import { verifyJwt, type JwtClaims } from './runtime/jwt.js'
import type { DbEngine } from './runtime/db/engine.js'
import type { RequestContext } from './runtime/types.js'
import { SUPACLOUD_LITE_VERSION } from './version.js'

/** Roles a data plane request may assume. Anything else is rejected. */
const allowedRoles = new Set(['anon', 'authenticated', 'service_role'])

const corsHeaders: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
  'access-control-allow-headers':
    'authorization, apikey, content-type, prefer, accept, accept-profile, content-profile, range, x-client-info, x-supabase-api-version, cache-control',
  'access-control-expose-headers': 'content-range, range-unit, content-profile, etag',
  'access-control-max-age': '86400',
}

function withCors(response: Response): Response {
  for (const [name, value] of Object.entries(corsHeaders)) {
    if (!response.headers.has(name)) response.headers.set(name, value)
  }
  return response
}

function json(status: number, body: unknown): Response {
  return withCors(new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }))
}

/**
 * Channels a schema reload may arrive on.
 *
 * `pgrst` keeps existing `NOTIFY pgrst, 'reload schema'` deploy steps working;
 * `supacloud_schema_reload` is the platform-owned spelling.
 */
export const DEFAULT_SCHEMA_RELOAD_CHANNELS = ['pgrst', 'supacloud_schema_reload'] as const

export interface DataPlaneOptions {
  /** Engine bound to a database that is already bootstrapped. */
  engine: DbEngine
  /** HMAC secret shared with GoTrue; project JWTs and `apikey` values verify here. */
  jwtSecret: string
  /** Schemas reachable through `Accept-Profile`/`Content-Profile`. Defaults to `public`. */
  exposedSchemas?: string[]
  /** Row cap for reads. Undefined means unlimited. */
  maxRows?: number
  /** Project reference reported by the health endpoint. */
  projectRef?: string
  /**
   * Channels to listen on for schema reload. Pass `[]` to disable. When the
   * engine cannot `LISTEN`, this is reported as `unavailable` in `/health`
   * instead of silently pretending reload works.
   */
  schemaReloadChannels?: readonly string[]
  /** Operator-visible log sink. */
  log?: (message: string) => void
  /**
   * Close the engine on `close()`. Defaults to `true`, which is right when this
   * data plane owns the engine. Pass `false` when the engine (or its pool) is
   * shared with another component such as a ZenStack adapter.
   */
  closeEngine?: boolean
}

/** Whether cross-process schema reload is actually wired. */
export type SchemaReloadState = 'active' | 'unavailable' | 'disabled'

export interface DataPlane {
  /** Serve one request. The only supported paths are `/health` and `/rest/v1/*`. */
  fetch(request: Request): Promise<Response>
  /** Close the attached database engine and every schema-reload subscription. */
  close(): Promise<void>
  /** Reload capability actually in effect, reported by `/health`. */
  readonly schemaReload: SchemaReloadState
}

/** Resolve the API key on a request into a role-scoped context. */
async function resolveContext(
  request: Request,
  url: URL,
  jwtSecret: string,
): Promise<RequestContext | Response> {
  const authorization = request.headers.get('authorization')
  const bearer = authorization?.toLowerCase().startsWith('bearer ') ? authorization.slice(7) : null
  const token = bearer ?? request.headers.get('apikey') ?? url.searchParams.get('apikey')
  if (!token) {
    return json(401, {
      message: 'No API key found in request',
      hint: 'No `apikey` request header or url param was found.',
    })
  }
  const claims = await verifyJwt(token, jwtSecret)
  if (!claims) return json(401, { message: 'Invalid API key' })
  const role = typeof claims.role === 'string' ? claims.role : 'anon'
  if (!allowedRoles.has(role)) return json(401, { message: `Invalid role: ${role}` })
  return { role, claims }
}

/**
 * Create a data plane over an existing database.
 *
 * The database is attached, not created: roles, schemas, grants and extensions
 * remain owned by project provisioning and the single migration ledger.
 *
 * This is async because schema-reload subscriptions must be established before
 * the first request is served; a cache that reloads "later" is a cache that
 * serves stale columns in production.
 */
export async function createDataPlane(options: DataPlaneOptions): Promise<DataPlane> {
  const { engine, jwtSecret } = options
  const closeEngine = options.closeEngine !== false
  const log = options.log ?? (() => {})
  const database = Database.attach(engine)
  const rest = new RestHandler(database, {
    ...(options.exposedSchemas ? { exposedSchemas: options.exposedSchemas } : {}),
    ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
  })
  const projectRef = options.projectRef ?? 'unknown'
  const channels = options.schemaReloadChannels ?? DEFAULT_SCHEMA_RELOAD_CHANNELS

  const subscriptions: Array<() => void | Promise<void>> = []
  let schemaReload: SchemaReloadState = channels.length === 0 ? 'disabled' : 'unavailable'
  for (const channel of channels) {
    try {
      subscriptions.push(await engine.listen(channel, () => {
        // PostgREST's `reload schema` is all-schemas; the payload names a schema
        // only for logging. Clearing every cache matches that behaviour and can
        // never leave one schema stale.
        database.invalidateSchemaCache()
        rest.invalidateOpenApiCache()
        log(`schema cache invalidated via ${channel}`)
      }))
      schemaReload = 'active'
    } catch (error) {
      log(`schema reload unavailable on ${channel}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (request.method.toUpperCase() === 'OPTIONS') {
      return withCors(new Response(null, { status: 204, headers: corsHeaders }))
    }

    if (path === '/health') {
      try {
        await engine.query('select 1')
      } catch (error) {
        return json(503, {
          name: 'supacloud-dataplane',
          project_ref: projectRef,
          status: 'unhealthy',
          engine: 'postgres',
          version: SUPACLOUD_LITE_VERSION,
          schema_reload: schemaReload,
          error: error instanceof Error ? error.message : 'database probe failed',
        })
      }
      return json(200, {
        name: 'supacloud-dataplane',
        project_ref: projectRef,
        status: 'healthy',
        engine: 'postgres',
        version: SUPACLOUD_LITE_VERSION,
        schema_reload: schemaReload,
      })
    }

    // PostgREST answers its OpenAPI document on the root path, and clients rely
    // on that; `/` is aliased to `/rest/v1/` instead of serving health, which
    // would silently change what a PostgREST client receives.
    const isRootAlias = path === '/'
    if (isRootAlias && !['GET', 'HEAD'].includes(request.method.toUpperCase())) {
      // The root path is an introspection document, not a second write surface.
      const response = json(405, {
        message: `Method ${request.method.toUpperCase()} is not allowed on the data plane root`,
      })
      response.headers.set('allow', 'GET, HEAD')
      return response
    }
    if (!isRootAlias && !path.startsWith('/rest/v1')) {
      // Auth, storage, functions and realtime are separate processes. Answering
      // them here would silently create a second runtime.
      return json(404, {
        message: `Data plane serves /rest/v1 only: ${path}`,
        hint: 'auth, storage, functions and realtime run on their own endpoints',
      })
    }

    const context = await resolveContext(request, url, jwtSecret)
    if (context instanceof Response) return context

    if (isRootAlias) {
      const target = new URL(url.toString())
      target.pathname = '/rest/v1/'
      return withCors(await rest.handle(request, context, target))
    }
    return withCors(await rest.handle(request, context, url))
  }

  return {
    async fetch(request: Request): Promise<Response> {
      try {
        return await handle(request)
      } catch (error) {
        return json(500, {
          message: 'Internal data plane error',
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    },
    async close(): Promise<void> {
      for (const unsubscribe of subscriptions) {
        try {
          await unsubscribe()
        } catch (error) {
          log(`schema reload unsubscribe failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (closeEngine) await engine.close()
    },
    get schemaReload(): SchemaReloadState {
      return schemaReload
    },
  }
}

export interface DataPlaneConfig {
  databaseUrl: string
  jwtSecret: string
  port: number
  host: string
  exposedSchemas: string[]
  maxRows?: number
  projectRef: string
}

function read(env: Record<string, string | undefined>, primary: string, fallback?: string): string | undefined {
  const value = env[primary]?.trim()
  if (value) return value
  const alternate = fallback ? env[fallback]?.trim() : undefined
  return alternate ? alternate : undefined
}

/**
 * Parse the process environment into data plane configuration.
 *
 * `PGRST_*` names are accepted as fallbacks so an existing per-project unit file
 * can point at this binary without being regenerated; `DATA_PLANE_*` wins when
 * both are present.
 */
export function readDataPlaneConfig(env: Record<string, string | undefined> = process.env): DataPlaneConfig {
  const databaseUrl = read(env, 'DATA_PLANE_DATABASE_URL', 'PGRST_DB_URI')
  if (!databaseUrl) throw new Error('DATA_PLANE_DATABASE_URL (or PGRST_DB_URI) is required')
  const jwtSecret = read(env, 'DATA_PLANE_JWT_SECRET', 'PGRST_JWT_SECRET')
  if (!jwtSecret) throw new Error('DATA_PLANE_JWT_SECRET (or PGRST_JWT_SECRET) is required')

  const rawPort = read(env, 'DATA_PLANE_PORT', 'PGRST_SERVER_PORT') ?? '3000'
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`DATA_PLANE_PORT must be a valid TCP port, received ${rawPort}`)
  }

  const rawSchemas = read(env, 'DATA_PLANE_SCHEMAS', 'PGRST_DB_SCHEMAS') ?? 'public'
  const exposedSchemas = rawSchemas.split(',').map((name) => name.trim()).filter((name) => name.length > 0)
  if (exposedSchemas.length === 0) throw new Error('DATA_PLANE_SCHEMAS must list at least one schema')

  const rawMaxRows = read(env, 'DATA_PLANE_MAX_ROWS', 'PGRST_DB_MAX_ROWS')
  let maxRows: number | undefined
  if (rawMaxRows) {
    const parsed = Number(rawMaxRows)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`DATA_PLANE_MAX_ROWS must be a positive integer, received ${rawMaxRows}`)
    }
    maxRows = parsed
  }

  return {
    databaseUrl,
    jwtSecret,
    port,
    host: read(env, 'DATA_PLANE_HOST') ?? '127.0.0.1',
    exposedSchemas,
    ...(maxRows === undefined ? {} : { maxRows }),
    projectRef: read(env, 'DATA_PLANE_PROJECT_REF') ?? 'unknown',
  }
}

export type { JwtClaims }