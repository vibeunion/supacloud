/**
 * OpenAPI 3.0 document for the Data API root (`GET /rest/v1/`).
 *
 * PostgREST publishes an OpenAPI document there and downstream tooling reads
 * it: type generation, CLI introspection, and client SDK scaffolding. The
 * document describes tables, views, columns and RPC entry points — it is a
 * capability report, not a promise that every operator is implemented.
 */

import type { Database, FunctionInfo, SchemaInfo, TableInfo } from '../db/database.js'

export interface OpenApiOptions {
  /** Schema the request negotiated through `Accept-Profile`. */
  schema: string
  /**
   * Role the verified JWT selected. The document lists only objects that role
   * may reach, matching PostgREST: an `anon` caller must not learn the shape of
   * tables it cannot read.
   */
  role: string
  /** Schemas advertised under `info` for operator visibility. */
  exposedSchemas: readonly string[]
  /** Runtime version reported in `info.version`. */
  version: string
  /** Absolute base URL, when the caller can determine it. */
  serverUrl?: string
}

const integerTypes = new Set(['int2', 'int4', 'smallint', 'integer', 'oid'])
const numberTypes = new Set(['numeric', 'float4', 'float8', 'decimal', 'real', 'double precision', 'money'])
const jsonTypes = new Set(['json', 'jsonb'])
const dateTimeTypes = new Set(['timestamptz', 'timestamp with time zone'])
const dateTypes = new Set(['date'])
const timeTypes = new Set(['time', 'timetz', 'time without time zone', 'time with time zone'])
const booleanTypes = new Set(['bool', 'boolean'])

type JsonSchema = Record<string, unknown>

/** Map a PostgreSQL `udt_name` to the JSON Schema PostgREST clients expect. */
function columnSchema(udtName: string, nullable: boolean): JsonSchema {
  const name = udtName.trim().toLowerCase()
  const nullableSuffix = nullable ? { nullable: true } : {}
  if (name.startsWith('_')) {
    return { type: 'array', items: columnSchema(name.slice(1), false), ...nullableSuffix }
  }
  if (integerTypes.has(name)) return { type: 'integer', format: 'int32', ...nullableSuffix }
  if (name === 'int8' || name === 'bigint') return { type: 'integer', format: 'int64', ...nullableSuffix }
  if (numberTypes.has(name)) return { type: 'number', ...nullableSuffix }
  if (booleanTypes.has(name)) return { type: 'boolean', ...nullableSuffix }
  if (jsonTypes.has(name)) return { type: 'object', ...nullableSuffix }
  if (dateTimeTypes.has(name)) return { type: 'string', format: 'date-time', ...nullableSuffix }
  if (dateTypes.has(name)) return { type: 'string', format: 'date', ...nullableSuffix }
  if (timeTypes.has(name)) return { type: 'string', format: 'time', ...nullableSuffix }
  if (name === 'uuid') return { type: 'string', format: 'uuid', ...nullableSuffix }
  if (name === 'bytea') return { type: 'string', format: 'bytea', ...nullableSuffix }
  return { type: 'string', ...nullableSuffix }
}

function tableSchema(table: TableInfo): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  for (const column of table.columns) {
    properties[column.name] = columnSchema(column.udtName, column.isNullable)
  }
  return {
    type: 'object',
    properties,
    ...(table.primaryKey.length > 0 ? { required: [] as string[] } : {}),
    ...(table.primaryKey.length > 0
      ? { 'x-primary-key': [...table.primaryKey] }
      : {}),
  }
}

function collectionResponse(ref: string): JsonSchema {
  return {
    description: 'Rows matching the filter, shaped by `select`',
    content: {
      'application/json': {
        schema: { type: 'array', items: { $ref: `#/components/schemas/${ref}` } },
      },
    },
  }
}

function mutationResponse(ref: string): JsonSchema {
  return {
    description: 'Mutated rows when `Prefer: return=representation` is requested',
    content: {
      'application/json': {
        schema: { type: 'array', items: { $ref: `#/components/schemas/${ref}` } },
      },
    },
  }
}

function tablePaths(table: TableInfo): Record<string, JsonSchema> {
  const ref = table.name
  const read = collectionResponse(ref)
  return {
    [`/${table.name}`]: {
      get: {
        tags: [table.schema],
        summary: `Read ${table.schema}.${table.name}`,
        parameters: [
          { name: 'select', in: 'query', schema: { type: 'string' } },
          { name: 'order', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'offset', in: 'query', schema: { type: 'integer' } },
          { name: 'Range', in: 'header', schema: { type: 'string' } },
          { name: 'Accept-Profile', in: 'header', schema: { type: 'string' } },
        ],
        responses: {
          200: read,
          206: read,
          406: { description: 'Requested schema is not exposed' },
        },
      },
      post: {
        tags: [table.schema],
        summary: `Insert into ${table.schema}.${table.name}`,
        parameters: [
          { name: 'Prefer', in: 'header', schema: { type: 'string' } },
          { name: 'Content-Profile', in: 'header', schema: { type: 'string' } },
        ],
        responses: {
          201: mutationResponse(ref),
          400: { description: 'Malformed request body' },
          409: { description: 'Unique or foreign key violation' },
        },
      },
      patch: {
        tags: [table.schema],
        summary: `Update rows in ${table.schema}.${table.name}`,
        parameters: [
          { name: 'Prefer', in: 'header', schema: { type: 'string' } },
          { name: 'Content-Profile', in: 'header', schema: { type: 'string' } },
        ],
        responses: {
          200: mutationResponse(ref),
          204: { description: 'No body requested via `Prefer: return=minimal`' },
        },
      },
      delete: {
        tags: [table.schema],
        summary: `Delete rows in ${table.schema}.${table.name}`,
        parameters: [
          { name: 'Prefer', in: 'header', schema: { type: 'string' } },
          { name: 'Content-Profile', in: 'header', schema: { type: 'string' } },
        ],
        responses: {
          200: mutationResponse(ref),
          204: { description: 'No body requested via `Prefer: return=minimal`' },
        },
      },
    },
  }
}

function functionArgumentSchema(fn: FunctionInfo): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  fn.args.forEach((arg, index) => {
    const name = arg.name && arg.name.length > 0 ? arg.name : `arg${index}`
    properties[name] = { type: 'string', 'x-postgres-type': arg.type }
    if (index < fn.requiredArgCount) required.push(name)
  })
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

function functionPaths(fn: FunctionInfo): Record<string, JsonSchema> {
  const name = fn.name
  return {
    [`/rpc/${name}`]: {
      post: {
        tags: [fn.schema],
        summary: `Call ${fn.schema}.${name}`,
        description: fn.volatility === 'v' ? 'Volatile function' : 'Stable function',
        requestBody: {
          required: fn.requiredArgCount > 0,
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  functionArgumentSchema(fn),
                  { type: 'array', items: functionArgumentSchema(fn) },
                ],
              },
            },
          },
        },
        responses: {
          200: {
            description: fn.returnsSet
              ? 'Result set'
              : 'Function return value',
            content: { 'application/json': { schema: {} } },
          },
          404: { description: 'Function not found in the exposed schema' },
        },
      },
    },
  }
}

/**
 * Build the OpenAPI document for one schema.
 *
 * The document lists the negotiated schema only, matching PostgREST: a client
 * that asks for `Accept-Profile: graphql_public` sees that schema's surface.
 */
export async function buildRestOpenApiDocument(
  db: Database,
  options: OpenApiOptions,
): Promise<Record<string, unknown>> {
  const info: SchemaInfo = await db.getSchemaInfo(options.schema)
  const [functions, accessibleRelations] = await Promise.all([
    // Privilege filtering happens per overload, inside the query: filtering by
    // function name would keep the name and leak a sibling overload's shape.
    db.listFunctions(options.schema, { role: options.role }),
    db.listAccessibleRelations(options.schema, options.role),
  ])

  const schemas: Record<string, JsonSchema> = {}
  const paths: Record<string, JsonSchema> = {}
  // Stable ordering keeps the document byte-identical across requests, which
  // matters for generated-client drift checks.
  for (const table of [...info.tables.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!accessibleRelations.has(table.name)) continue
    schemas[table.name] = tableSchema(table)
    Object.assign(paths, tablePaths(table))
  }
  for (const fn of [...functions].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    // One path per name: OpenAPI 3.0 cannot express PostgreSQL overloads, so the
    // first overload wins instead of the last one overwriting it arbitrarily.
    if (`/rpc/${fn.name}` in paths) continue
    Object.assign(paths, functionPaths(fn))
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'supacloud-dataplane',
      version: options.version,
      description: `PostgREST-compatible Data API for schema "${options.schema}"`,
      'x-exposed-schemas': [...options.exposedSchemas],
      'x-role': options.role,
    },
    ...(options.serverUrl ? { servers: [{ url: options.serverUrl }] } : {}),
    paths,
    components: {
      schemas,
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: 'apikey' },
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
    security: [{ apiKey: [] }, { bearer: [] }],
    externalDocs: { description: 'SupaCloud data plane', url: 'https://github.com/vibeunion/supacloud' },
  }
}