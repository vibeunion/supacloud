import type { DbEngine } from './db/engine.js'
import type { Database } from './db/database.js'
import { ApiError, type RequestContext } from './types.js'

export interface GraphqlCapability {
  status: 'supported' | 'unsupported' | 'disabled' | 'unverified'
  extension: 'pg_graphql'
  version?: string
  reason?: string
}

export interface GraphqlOptions {
  /** true requires the extension at startup; false disables the endpoint; omitted auto-detects. */
  enabled?: boolean
  maxRequestBodyBytes?: number
  statementTimeoutMs?: number
}

export async function inspectGraphql(engine: DbEngine): Promise<GraphqlCapability> {
  const result = await engine.query<{ extversion: string; resolver: boolean }>(`
    select e.extversion, exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_depend d on d.classid = 'pg_proc'::regclass and d.objid = p.oid
        and d.refclassid = 'pg_extension'::regclass and d.refobjid = e.oid and d.deptype = 'e'
      where n.nspname = 'graphql' and p.proname = 'resolve' and not p.prosecdef
        and p.oid = to_regprocedure('graphql.resolve(text,jsonb,text,jsonb)')
    ) as resolver from pg_extension e where e.extname = 'pg_graphql'
  `)
  const row = result.rows[0]
  if (row?.resolver) {
    try {
      // Load the real extension library too; a catalog entry alone cannot prove ABI availability.
      await engine.query(`select graphql.resolve('{ __typename }', '{}'::jsonb, null, '{}'::jsonb)`)
    } catch {
      return { status: 'unsupported', extension: 'pg_graphql', version: row.extversion, reason: 'PG_GRAPHQL_RESOLVER_FAILED' }
    }
  }
  return row?.resolver
    ? { status: 'supported', extension: 'pg_graphql', version: row.extversion }
    : { status: 'unsupported', extension: 'pg_graphql',
        reason: row ? 'PG_GRAPHQL_RESOLVER_UNAVAILABLE' : 'PG_GRAPHQL_NOT_INSTALLED' }
}

export class GraphqlHandler {
  readonly maxBytes: number
  readonly timeoutMs: number

  constructor(private db: Database, private capability: GraphqlCapability, options: GraphqlOptions = {}, private schemas = ['public']) {
    this.maxBytes = positive(options.maxRequestBodyBytes ?? 1024 * 1024)
    this.timeoutMs = positive(options.statementTimeoutMs ?? 30_000)
  }

  async handle(request: Request, context: RequestContext): Promise<Response> {
    if (this.capability.status !== 'supported') {
      return response(this.capability.status === 'disabled' ? 404 : 501, {
        errors: [{ message: 'GraphQL requires the real pg_graphql extension and graphql.resolve.',
          extensions: { code: this.capability.reason ?? 'GRAPHQL_DISABLED' } }],
      })
    }
    if (request.method !== 'POST') return response(405, { errors: [{ message: 'Use POST for GraphQL requests.' }] }, { allow: 'POST' })
    try {
      if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        throw new ApiError(415, { message: 'GraphQL requests require application/json' })
      }
      const body: unknown = JSON.parse(await boundedBody(request, this.maxBytes))
      if (!isObject(body) || typeof body.query !== 'string' || !body.query.trim() ||
        (body.variables != null && !isObject(body.variables)) ||
        (body.extensions != null && !isObject(body.extensions)) ||
        (body.operationName != null && typeof body.operationName !== 'string')) {
        throw new ApiError(400, { message: 'Invalid GraphQL request' })
      }
      const result = await this.db.withContext(context, async (query) => {
        await query(`select set_config('statement_timeout', $1, true)`, [String(this.timeoutMs)])
        await query(`select set_config('search_path', $1, true)`, [
          this.schemas.map((schema) => `"${schema.replaceAll('"', '""')}"`).join(','),
        ])
        return query<{ result: unknown }>(
          'select graphql.resolve($1::text, $2::jsonb, $3::text, $4::jsonb) as result',
          [body.query, JSON.stringify(body.variables ?? {}), body.operationName ?? null, JSON.stringify(body.extensions ?? {})]
        )
      })
      return response(200, result.rows[0]?.result)
    } catch (error) {
      if (error instanceof ApiError) return response(error.status, { errors: [{ message: error.message }] })
      if (error instanceof SyntaxError) return response(400, { errors: [{ message: 'Invalid JSON request' }] })
      // Never return SQL, connection details or database exception text to callers.
      const databaseError = error as { code?: string; errno?: string }
      const code = databaseError.errno ?? databaseError.code
      const status = code === '42501' ? 403 : code === '57014' ? 504 : 500
      return response(status, { errors: [{ message: 'GraphQL execution failed',
        extensions: { code: status === 403 ? 'GRAPHQL_ACCESS_DENIED' : status === 504 ? 'GRAPHQL_TIMEOUT' : 'GRAPHQL_EXECUTION_FAILED' } }] })
    }
  }
}

async function boundedBody(request: Request, limit: number): Promise<string> {
  if (Number(request.headers.get('content-length')) > limit) throw new ApiError(413, { message: 'GraphQL request too large' })
  const reader = request.body?.getReader()
  if (!reader) throw new ApiError(400, { message: 'GraphQL request body required' })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) {
        await reader.cancel().catch(() => {})
        throw new ApiError(413, { message: 'GraphQL request too large' })
      }
      chunks.push(chunk.value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks).toString('utf8')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error('GraphQL limits must be positive bounded integers')
  return value
}
function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })
}
