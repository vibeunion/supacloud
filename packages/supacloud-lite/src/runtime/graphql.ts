import type { Database } from './db/database.js'
import { executeHasuraRead } from './graphql-hasura.js'
import { ApiError, type RequestContext } from './types.js'
import { errorProperty, isRecord } from './validation.js'

/**
 * Lite `/graphql/v1` executes Hasura-shaped reads as SQL in the caller's
 * transaction, so PostgreSQL GRANT and RLS apply. It does not call pg_graphql
 * and it does not embed Postrust. Mutations, aggregates, subscriptions, and
 * relationship filters are rejected instead of simulated.
 */
export const LITE_GRAPHQL_CONTRACT = {
  path: '/graphql/v1',
  dialect: 'postrust-hasura',
  hostedDialect: 'postrust-hasura',
  interchangeableWithHosted: true,
  limits: [
    'mutations-not-implemented',
    'aggregates-not-implemented',
    'subscriptions-not-implemented',
    'relationship-filters-not-implemented',
    'db-pre-request-not-applied',
    'relay-documents-rejected',
  ],
} as const

export interface GraphqlCapability {
  status: 'supported' | 'unsupported' | 'disabled' | 'unverified'
  extension: 'postrust-hasura'
  dialect: 'postrust-hasura'
  version?: string
  reason?: string
}

export interface GraphqlOptions {
  /** true requires the extension at startup; false disables the endpoint; omitted auto-detects. */
  enabled?: boolean
  maxRequestBodyBytes?: number
  statementTimeoutMs?: number
  slowQueryThresholdMs?: number
  onRequest?: (metric: GraphqlRequestMetric) => void
}

export interface GraphqlRequestMetric {
  operationName?: string
  status: number
  durationMs: number
  slow: boolean
}

export async function inspectGraphql(): Promise<GraphqlCapability> {
  return { status: 'supported', extension: 'postrust-hasura', dialect: 'postrust-hasura' }
}

export class GraphqlHandler {
  readonly maxBytes: number
  readonly timeoutMs: number
  readonly slowQueryThresholdMs: number
  private readonly onRequest: GraphqlOptions['onRequest']

  constructor(private db: Database, private capability: GraphqlCapability, options: GraphqlOptions = {}, private schemas = ['public']) {
    this.maxBytes = positive(options.maxRequestBodyBytes ?? 1024 * 1024)
    this.timeoutMs = positive(options.statementTimeoutMs ?? 30_000)
    this.slowQueryThresholdMs = positive(options.slowQueryThresholdMs ?? 1_000)
    this.onRequest = options.onRequest
  }

  async handle(request: Request, context: RequestContext): Promise<Response> {
    const startedAt = performance.now()
    let operationName: string | undefined
    const finish = (result: Response): Response => {
      const durationMs = Math.round((performance.now() - startedAt) * 100) / 100
      this.onRequest?.({
        ...(operationName === undefined ? {} : { operationName }),
        status: result.status,
        durationMs,
        slow: durationMs >= this.slowQueryThresholdMs,
      })
      return result
    }
    if (this.capability.status !== 'supported') {
      return finish(response(this.capability.status === 'disabled' ? 404 : 501, {
        errors: [{ message: 'GraphQL is disabled.',
          extensions: { code: this.capability.reason ?? 'GRAPHQL_DISABLED' } }],
      }))
    }
    if (request.method !== 'POST') return finish(response(405, { errors: [{ message: 'Use POST for GraphQL requests.' }] }, { allow: 'POST' }))
    try {
      if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        throw new ApiError(415, { message: 'GraphQL requests require application/json' })
      }
      const body: unknown = JSON.parse(await boundedBody(request, this.maxBytes))
      if (!isObject(body) || typeof body["query"] !== 'string' || !body["query"].trim() ||
        (body["variables"] != null && !isObject(body["variables"])) ||
        (body["extensions"] != null && !isObject(body["extensions"])) ||
        (body["operationName"] != null && typeof body["operationName"] !== 'string')) {
        throw new ApiError(400, { message: 'Invalid GraphQL request' })
      }
      const documentSource = body["query"]
      if (typeof documentSource !== 'string') throw new ApiError(400, { message: 'Invalid GraphQL request' })
      operationName = typeof body["operationName"] === 'string' ? body["operationName"] : undefined
      const envelope = await this.db.withContext(context, async (query) => {
        await query<unknown>(`select set_config('statement_timeout', $1, true)`, [String(this.timeoutMs)])
        return executeHasuraRead({
          query,
          schemas: this.schemas,
          source: documentSource,
          variableValues: isRecord(body["variables"]) ? body["variables"] : null,
          operationName,
        })
      })
      return finish(response(200, envelope))
    } catch (error) {
      if (error instanceof ApiError) return finish(response(error.status, { errors: [{ message: error.message }] }))
      if (error instanceof SyntaxError) return finish(response(400, { errors: [{ message: 'Invalid JSON request' }] }))
      // Never return SQL, connection details or database exception text to callers.
      const code = errorProperty(error, 'errno') ?? errorProperty(error, 'code')
      const status = code === '42501' ? 403 : code === '57014' ? 504 : 500
      return finish(response(status, { errors: [{ message: 'GraphQL execution failed',
        extensions: { code: status === 403 ? 'GRAPHQL_ACCESS_DENIED' : status === 504 ? 'GRAPHQL_TIMEOUT' : 'GRAPHQL_EXECUTION_FAILED' } }] })
      )
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
