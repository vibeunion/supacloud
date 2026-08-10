/**
 * SupaCloud Lite - a pure-JS, Docker-free Supabase backend on PGlite that speaks
 * the same wire protocols as hosted Supabase, so the official supabase-js
 * SDK works unchanged.
 *
 * The core is a fetch handler (Request → Response): serve it over HTTP in
 * Node, or call it in-process in the browser by passing it as supabase-js's
 * `global.fetch`.
 */
import { AuthHandler } from './auth/handler.js'
import { RateLimiter } from './auth/rate-limit.js'
import { InboxMailer } from './auth/inbox.js'
import { SmsInbox } from './auth/sms-inbox.js'
import { loadAuthSettings } from './auth/settings.js'
import { LogBuffer } from './log-buffer.js'
import { FunctionsHandler, type EdgeFunction } from './functions/handler.js'
import { installDenoShim } from './functions/deno-shim.js'
import { installPgredisShim, PgredisCache } from './functions/pgredis.js'
import { Database } from './db/database.js'
import { signJwt, verifyJwt } from './jwt.js'
import { RealtimeEngine } from './realtime/engine.js'
import { RestHandler } from './rest/handler.js'
import { MemoryStorageDriver } from './storage/driver.js'
import { StorageHandler } from './storage/handler.js'
import { WebhooksService, type WebhookDelivery } from './webhooks/service.js'
import { CronService } from './cron/service.js'
import { NetService, type NetDelivery } from './net/service.js'
import { RetentionService } from './retention/service.js'
import type { BackendConfig, Mailer, MigrationFile, RequestContext, SmsSender } from './types.js'
import { assertSecretsSafe, isNetworkExposed } from './security.js'

export * from './types.js'
export { Database } from './db/database.js'
export { createPgliteEngine } from './db/pglite-engine.js'
export { MemoryStorageDriver } from './storage/driver.js'
export { InboxMailer, type InboxEntry } from './auth/inbox.js'
export { SmsInbox, type SmsInboxEntry } from './auth/sms-inbox.js'
export { LogBuffer, type LogEntry, type LogLevel } from './log-buffer.js'
export { RealtimeEngine, type RealtimeSocketLike } from './realtime/engine.js'
export { signJwt, verifyJwt, decodeJwt } from './jwt.js'
export { FunctionsHandler, type EdgeFunction, type FunctionContext } from './functions/handler.js'
export { type PgredisCacheBinding } from './functions/pgredis.js'
export { generateTypes } from './gen-types.js'
export { installDenoShim } from './functions/deno-shim.js'
export { WebhooksService, type WebhookConfig, type WebhookDelivery } from './webhooks/service.js'
export { CronService, cronMatches } from './cron/service.js'
export { NetService, type NetDelivery } from './net/service.js'
export { RetentionService, type RetentionConfig } from './retention/service.js'
export { snapshotSchema, diffSchemas, type SchemaSnapshot } from './db/schema-diff.js'
export { inspectDb, type TableInfo } from './db/inspect.js'

/**
 * A running SupaCloud Lite backend. The one field a consumer always needs is
 * {@link SupaCloudLiteBackend.fetch}; the rest expose the underlying services for
 * advanced/embedded use (in-process realtime, manual migrations, log access).
 * Returned by {@link createBackend}.
 */
export interface SupaCloudLiteBackend {
  /** The whole backend as a fetch handler. Pass to supabase-js as global.fetch for in-process use. */
  fetch: typeof fetch
  /** The database engine wrapper - run raw SQL, inspect schema, apply migrations. */
  db: Database
  /** Realtime (Postgres CDC → WebSocket) engine backing supabase.channel(). */
  realtime: RealtimeEngine
  /** Edge-function registry/dispatcher backing supabase.functions.invoke(). */
  functions: FunctionsHandler
  /** Database-webhook service (HTTP requests fired on row changes). */
  webhooks: WebhooksService
  /** pg_cron emulation scheduler. */
  cron: CronService
  /** pg_net emulation sender (net.http_* queue drain). */
  net: NetService
  /** Background sweeper that purges expired tokens and aged-out audit rows. */
  retention: RetentionService
  /** JWT for the anon role - use as supabase-js's supabaseKey. */
  anonKey: string
  /** JWT for the service_role - bypasses RLS. */
  serviceRoleKey: string
  /** Secret used to sign/verify every JWT (the resolved value, incl. the default). */
  jwtSecret: string
  /** Recent server logs (also surfaced in the Studio Logs pane). */
  logs: LogBuffer
  /** Captured dev email inbox mounted only on loopback, or null when disabled or replaced. */
  inbox: InboxMailer | null
  /** Independent captured dev SMS inbox mounted only on loopback, or null when a sender is configured/exposed. */
  smsInbox: SmsInbox | null
  /** Apply additional migrations at runtime. */
  migrate: (migrations: MigrationFile[], seedSql?: string) => Promise<string[]>
  /** Tear down every background service and close the database. Idempotent-safe to await once. */
  close: () => Promise<void>
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
  'access-control-allow-headers':
    'authorization, apikey, content-type, prefer, accept, accept-profile, content-profile, range, x-upsert, x-client-info, x-supabase-api-version, cache-control',
  'access-control-expose-headers': 'content-range, range-unit, content-profile',
  'access-control-max-age': '86400',
}

/**
 * Build a running SupaCloud Lite backend from {@link BackendConfig}. Wires the
 * database, auth, storage, realtime, edge functions, and the background
 * services (webhooks/cron/net/retention), mints the anon/service_role keys, and
 * returns a {@link SupaCloudLiteBackend} whose `fetch` handles every Supabase wire
 * route.
 *
 * All config is optional: with an empty config it boots an in-memory PGlite
 * backend on the Supabase local-dev defaults. If any startup step throws (e.g. a
 * failing migration), every handle opened so far is torn down before the error
 * propagates, so a failed construction never leaks the engine or a timer.
 *
 * @throws Error from {@link assertSecretsSafe} when bound to a network-exposed
 *   host with a weak/default JWT secret or a derived vault key.
 */
export async function createBackend(config: BackendConfig = {}): Promise<SupaCloudLiteBackend> {
  const jwtSecret = config.jwtSecret ?? randomSecret()
  const apiUrl = config.apiUrl ?? 'http://localhost:54321'
  const siteUrl = config.siteUrl ?? apiUrl
  const jwtExpiry = config.jwtExpiry ?? 3600

  // capture server logs for the Studio "Logs" pane, still forwarding to the
  // configured logger (or console)
  const logs = new LogBuffer()
  const baseLog = config.log ?? ((m: string) => console.log(m))
  const log = (m: string) => {
    logs.push(m)
    baseLog(m)
  }

  // Vault encryption key: use the configured value, else derive one from the
  // JWT secret so vault secrets are encrypted at rest out of the box (better
  // than the old plaintext store). Set a dedicated vaultKey in production.
  const vaultKeyDerived = config.vaultKey === undefined
  const vaultKey = config.vaultKey ?? `supacloud-lite-vault:${jwtSecret}`

  // Weak/default secrets are fine on loopback; refuse to start with them when
  // the server is bound to a network-exposed host.
  assertSecretsSafe({ host: config.host, jwtSecret, vaultKeyDerived, warn: log })

  const engine = config.engine

  const db = await Database.create(engine ?? config.dataDir, { vaultKey })

  // Anything created after the engine (a running native Postgres child, the
  // realtime LISTEN, background timers) must be torn down if a later step throws
  // - e.g. a failing migration - so a construction error never leaks a handle.
  const cleanup: Array<() => void | Promise<void>> = []
  const failStartup = async (e: unknown): Promise<never> => {
    for (const fn of cleanup.reverse()) await Promise.resolve(fn()).catch(() => {})
    await db.close().catch(() => {})
    throw e
  }

  try {
    if (config.migrations?.length || config.seedSql) {
      const applied = await db.runMigrations(config.migrations ?? [], config.seedSql)
      if (applied.length > 0) log(`applied migrations: ${applied.join(', ')}`)
    }
  } catch (e) {
    await failStartup(e)
  }

  const pgredis = await PgredisCache.create(db).catch(failStartup)

  const now = Math.floor(Date.now() / 1000)
  const tenYears = 10 * 365 * 24 * 3600
  const anonKey = await signJwt({ iss: 'supabase', ref: 'local', role: 'anon', iat: now, exp: now + tenYears }, jwtSecret)
  const serviceRoleKey = await signJwt(
    { iss: 'supabase', ref: 'local', role: 'service_role', iat: now, exp: now + tenYears },
    jwtSecret
  )

  const exposedSchemas = [...new Set(config.dbSchemas ?? ['public', 'pgmq_public'])]
  const rest = new RestHandler(db, { exposedSchemas, maxRows: config.maxRows })
  const exposed = isNetworkExposed(config.host)
  const inbox = config.mailer || exposed
    ? null
    : new InboxMailer((msg) =>
        log(
          config.logMailBody
            ? `[mail] to=${msg.to} subject="${msg.subject}"\n${msg.text}`
            : `[mail] to=${msg.to} subject="${msg.subject}"`
        )
      )
  const mailer: Mailer = config.mailer ?? inbox ?? {
    async send(msg) {
      log(`[mail] to=${msg.to} subject="${msg.subject}"`)
    },
  }
  // Phone OTP has no console fallback: loopback gets a bounded dev inbox,
  // while network-exposed instances must inject an explicit SMS provider.
  const smsInbox = config.smsSender || exposed ? null : new SmsInbox()
  const smsSender: SmsSender | null = config.smsSender ?? smsInbox
  // one shared runtime-settings object: config.toml [auth] provides the
  // committed defaults, the persisted auth.config row layers live studio edits
  // on top, and the auth handler reads the merged object per request
  const authSettings = await loadAuthSettings(db, config.authSettings)
  const storage = new StorageHandler(db, config.storageDriver ?? new MemoryStorageDriver(), {
    jwtSecret,
    defaultFileSizeLimit: config.storageFileSizeLimit,
    log,
  })
  if (config.buckets?.length) await storage.ensureBuckets(config.buckets)
  const auth = new AuthHandler(db, {
    jwtSecret,
    apiUrl,
    siteUrl,
    jwtExpiry,
    sessionTimeboxSeconds: config.sessionTimeboxSeconds,
    sessionInactivitySeconds: config.sessionInactivitySeconds,
    mailer,
    smsSender,
    log,
    oauthProviders: config.oauthProviders,
    oauthFetch: config.oauthFetch,
    uriAllowList: config.uriAllowList,
    enforceRedirectAllowList: isNetworkExposed(config.host),
    settings: authSettings,
    rateLimiter: new RateLimiter(config.authRateLimits),
  })
  cleanup.push(() => auth.stop())

  const realtime = new RealtimeEngine(db, jwtSecret)
  const webhooks = new WebhooksService(
    db,
    config.webhookFetch,
    (d: WebhookDelivery) =>
      log(`[webhook] ${d.event.type} ${d.event.schema}.${d.event.table} -> ${d.webhook.url} ${d.ok ? d.status : 'FAILED ' + (d.error ?? '')}`),
    isNetworkExposed(config.host)
  )
  const cron = new CronService(db)
  const retention = new RetentionService(db, config.retention)
  const net = new NetService(db, config.netFetch, undefined, (d: NetDelivery) =>
    log(`[net] ${d.method} ${d.url} -> ${d.timedOut ? 'TIMEOUT' : d.error ? 'FAILED ' + d.error : d.status}`)
  )

  if (config.startRuntimeServices !== false) {
    try {
      await realtime.start()
      cleanup.push(() => realtime.stop())
      if (config.webhooks?.length) await webhooks.start(config.webhooks)
      cleanup.push(() => webhooks.stopService())
      cron.start()
      cleanup.push(() => cron.stop())
      retention.start()
      cleanup.push(() => retention.stop())
      net.start()
      cleanup.push(() => net.stop())
    } catch (e) {
      await failStartup(e)
    }
  }

  const fnMap =
    config.functions instanceof Map
      ? config.functions
      : new Map(Object.entries(config.functions ?? {}))
  const fnEnv = {
    SUPABASE_URL: apiUrl,
    SUPABASE_ANON_KEY: anonKey,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    ...(config.functionEnv ?? {}),
  }

  // install the Deno global once per process; the shim's Deno.env is bound to
  // this backend's fnEnv per-invocation by FunctionsHandler (so backends don't
  // share env through the global).
  installDenoShim()
  try {
    installPgredisShim()
  } catch (error) {
    await failStartup(error)
  }
  const functions = new FunctionsHandler(fnMap as Map<string, EdgeFunction>, fnEnv, pgredis)

  async function resolveContext(req: Request, url: URL): Promise<RequestContext | Response> {
    const authz = req.headers.get('authorization')
    const bearer = authz?.toLowerCase().startsWith('bearer ') ? authz.slice(7) : null
    const token = bearer ?? req.headers.get('apikey') ?? url.searchParams.get('apikey')
    if (!token) {
      return withCors(
        new Response(JSON.stringify({ message: 'No API key found in request', hint: 'No `apikey` request header or url param was found.' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      )
    }
    const claims = await verifyJwt(token, jwtSecret)
    if (!claims) {
      return withCors(
        new Response(JSON.stringify({ message: 'Invalid API key' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      )
    }
    const role = typeof claims.role === 'string' ? claims.role : 'anon'
    if (!['anon', 'authenticated', 'service_role'].includes(role)) {
      return withCors(
        new Response(JSON.stringify({ message: `Invalid role: ${role}` }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      )
    }
    return { role, claims }
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname

    if (req.method === 'OPTIONS' && (path === '/functions/v1' || path.startsWith('/functions/v1/'))) {
      return functions.handle(req, { role: 'anon', claims: null }, url)
    }
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }
    if (path === '/' || path === '/health') {
      return withCors(
        new Response(JSON.stringify({ name: 'supacloud-lite', project_ref: 'local', status: 'healthy' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    }

    if (inbox && (path === '/inbox' || path.startsWith('/inbox/'))) {
      return withCors(inbox.serve(req, url))
    }
    if (smsInbox && (path === '/sms-inbox' || path.startsWith('/sms-inbox/'))) {
      return withCors(smsInbox.serve(req, url))
    }

    // public endpoints that skip apikey checks
    if (
      path.startsWith('/storage/v1/object/public/') ||
      path.startsWith('/storage/v1/object/sign/') ||
      path.startsWith('/storage/v1/render/image/public/') ||
      path.startsWith('/storage/v1/render/image/sign/')
    ) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        return withCors(await storage.handle(req, { role: 'anon', claims: null }, url))
      }
    }
    if (config.authEnabled === false && path.startsWith('/auth/v1')) {
      return withCors(
        new Response(JSON.stringify({ message: 'Auth service is disabled' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      )
    }
    if (
      (path === '/auth/v1/verify' || path === '/auth/v1/authorize' || path === '/auth/v1/callback') &&
      (req.method === 'GET' || req.method === 'POST')
    ) {
      // email-link clicks and OAuth provider redirects arrive without an apikey
      return withCors(await auth.handle(req, { role: 'anon', claims: null }, url))
    }
    if (path.startsWith('/auth/v1/')) {
      // GoTrue validates the apikey header, but user JWTs ride Authorization
      const apikey = req.headers.get('apikey') ?? url.searchParams.get('apikey')
      const keyClaims = apikey ? await verifyJwt(apikey, jwtSecret) : null
      if (!keyClaims) {
        return withCors(
          new Response(JSON.stringify({ message: 'No API key found in request' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          })
        )
      }
      const ctx: RequestContext = { role: String(keyClaims.role ?? 'anon'), claims: keyClaims }
      return withCors(await auth.handle(req, ctx, url))
    }

    if (path.startsWith('/functions/v1/')) {
      const functionName = path.replace(/^\/functions\/v1\/?/, '').split('/')[0]
      if (functionName && config.functionVerifyJwt?.[functionName] === false) {
        return withCors(await functions.handle(req, { role: 'anon', claims: null }, url))
      }
    }

    const ctx = await resolveContext(req, url)
    if (ctx instanceof Response) return ctx

    if (path.startsWith('/rest/v1')) return withCors(await rest.handle(req, ctx, url))
    if (path.startsWith('/functions/v1')) return withCors(await functions.handle(req, ctx, url))
    if (path.startsWith('/storage/v1')) return withCors(await storage.handle(req, ctx, url))
    if (path.startsWith('/realtime/v1')) {
      return withCors(
        new Response(JSON.stringify({ message: 'Realtime requires a WebSocket connection' }), {
          status: 426,
          headers: { 'content-type': 'application/json' },
        })
      )
    }
    return withCors(
      new Response(JSON.stringify({ message: `Unknown endpoint: ${path}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    )
  }

  // Last-resort guard: the fetch contract is Request → Response, so an
  // unexpected throw from any handler must become a 500, never a rejected fetch
  // (in-process/browser callers have no HTTP layer to convert a rejection).
  const safeHandle = async (req: Request): Promise<Response> => {
    try {
      return await handle(req)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log(`[error] unhandled: ${msg}`)
      return withCors(
        new Response(JSON.stringify({ message: 'Internal Server Error' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      )
    }
  }

  // request logging for the Logs pane (skip health checks and the log-polling
  // endpoint itself to avoid noise / self-reference)
  const loggedFetch = async (req: Request): Promise<Response> => {
    const res = await safeHandle(req)
    try {
      const p = new URL(req.url).pathname
      if (p !== '/health' && p !== '/') {
        const level = res.status >= 500 ? 'error' : res.status >= 400 ? 'warn' : 'info'
        logs.push(`${req.method} ${p} → ${res.status}`, level)
      }
    } catch {
      // never let logging break a response
    }
    return res
  }

  let closePromise: Promise<void> | null = null
  const publicFetch: typeof fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request && init === undefined ? input : new Request(input, init)
      return loggedFetch(request)
    },
    { preconnect: fetch.preconnect }
  )

  return {
    fetch: publicFetch,
    db,
    realtime,
    functions,
    webhooks,
    cron,
    net,
    retention,
    anonKey,
    serviceRoleKey,
    jwtSecret,
    logs,
    inbox,
    smsInbox,
    migrate: (migrations, seedSql) => db.runMigrations(migrations, seedSql),
    close: () => {
      closePromise ??= (async () => {
        let firstError: unknown
        const stop = async (operation: () => void | Promise<void>) => {
          try {
            await operation()
          } catch (error) {
            firstError ??= error
          }
        }
        await stop(() => auth.stop())
        await stop(() => cron.stop())
        await stop(() => net.stop())
        await stop(() => retention.stop())
        await stop(() => webhooks.stopService())
        await stop(() => realtime.stop())
        await stop(() => db.close())
        if (firstError !== undefined) throw firstError
      })()
      return closePromise
    },
  }
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(48))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Add the permissive CORS headers to a response, leaving any already-set header untouched. */
function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    if (!res.headers.has(k)) res.headers.set(k, v)
  }
  return res
}
