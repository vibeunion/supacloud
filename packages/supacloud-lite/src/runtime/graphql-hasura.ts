import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLError,
  GraphQLFloat,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  graphql,
  parse,
  type GraphQLFieldConfig,
  type GraphQLOutputType,
  type GraphQLScalarType,
} from 'graphql'

/**
 * Read executor for the hosted Postrust Hasura document shape.
 * SQL runs inside the caller's transaction, so PostgreSQL GRANT and RLS apply.
 * Mutations, aggregates, subscriptions, and relationship filters are rejected.
 */

const MAX_DEPTH = 8
const ORDER = new GraphQLEnumType({
  name: 'order_by',
  values: {
    asc: { value: 'asc' },
    desc: { value: 'desc' },
    asc_nulls_first: { value: 'asc nulls first' },
    asc_nulls_last: { value: 'asc nulls last' },
    desc_nulls_first: { value: 'desc nulls first' },
    desc_nulls_last: { value: 'desc nulls last' },
  },
})

type Sql = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>
type Column = { name: string; type: string; primary: boolean }
type Table = {
  schema: string
  name: string
  field: string
  columns: Map<string, Column>
  primary: string[]
}
type ForeignKey = {
  name: string
  fromSchema: string
  fromTable: string
  fromCols: string[]
  toSchema: string
  toTable: string
  toCols: string[]
}
type Exec = { query: Sql; depth: number }

const COMPARISONS: Record<string, { scalar: GraphQLScalarType; ops: string[] }> = {
  Int: { scalar: GraphQLInt, ops: ['_eq', '_neq', '_gt', '_gte', '_lt', '_lte', '_in', '_is_null'] },
  Float: { scalar: GraphQLFloat, ops: ['_eq', '_neq', '_gt', '_gte', '_lt', '_lte', '_in', '_is_null'] },
  String: { scalar: GraphQLString, ops: ['_eq', '_neq', '_gt', '_gte', '_lt', '_lte', '_in', '_like', '_ilike', '_is_null'] },
  Boolean: { scalar: GraphQLBoolean, ops: ['_eq', '_neq', '_is_null'] },
}

export async function executeHasuraRead(input: {
  query: Sql
  schemas: readonly string[]
  source: string
  variableValues?: Record<string, unknown> | null
  operationName?: string | null
}): Promise<Record<string, unknown>> {
  let document
  try {
    document = parse(input.source)
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'Invalid GraphQL document', extensions: { code: 'validation-failed' } }] }
  }
  for (const definition of document.definitions) {
    if (definition.kind !== 'OperationDefinition') continue
    if (definition.operation === 'subscription') {
      return { errors: [{ message: 'GraphQL subscriptions are not served on Lite /graphql/v1.', extensions: { code: 'validation-failed' } }] }
    }
    if (definition.operation === 'mutation') {
      return { errors: [{ message: 'GraphQL mutations are not implemented on Lite. Hosted reads use query_root, where, order_by, and limit.', extensions: { code: 'validation-failed' } }] }
    }
  }
  const tables = await loadTables(input.query, input.schemas)
  const keys = await loadForeignKeys(input.query, input.schemas)
  const schema = buildSchema(tables, keys)
  const result = await graphql({
    schema,
    source: input.source,
    variableValues: input.variableValues ?? undefined,
    operationName: input.operationName ?? undefined,
    contextValue: { query: input.query, depth: 0 } satisfies Exec,
  })
  const body: Record<string, unknown> = {}
  if (result.data) body['data'] = result.data
  if (result.errors?.length) {
    body['errors'] = result.errors.map((error) => ({
      message: error.message,
      extensions: { code: 'validation-failed' },
    }))
    if (!result.data) body['data'] = null
  }
  return body
}

async function loadTables(query: Sql, schemas: readonly string[]): Promise<Table[]> {
  const result = await query(`
    select n.nspname as schema, c.relname as "table", a.attname as column, t.typname as type,
      exists (
        select 1 from pg_index i
        where i.indrelid = c.oid and i.indisprimary and a.attnum = any (i.indkey)
      ) as primary_key
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    join pg_type t on t.oid = a.atttypid
    where c.relkind in ('r', 'v')
      and n.nspname = any($1::name[])
      and has_table_privilege(c.oid, 'SELECT')
    order by n.nspname, c.relname, a.attnum
  `, [schemas])
  const tables = new Map<string, Table>()
  for (const row of result.rows) {
    if (!isRow(row)) continue
    const key = `${row['schema']}.${row['table']}`
    let table = tables.get(key)
    if (!table) {
      const name = String(row['table'])
      if (!graphqlName(name)) continue
      table = {
        schema: String(row['schema']),
        name,
        field: String(row['schema']) === 'public' ? name : `${row['schema']}_${name}`,
        columns: new Map(),
        primary: [],
      }
      tables.set(key, table)
    }
    const column = String(row['column'])
    if (!graphqlName(column)) continue
    const info = { name: column, type: String(row['type']), primary: row['primary_key'] === true }
    table.columns.set(column, info)
    if (info.primary) table.primary.push(column)
  }
  return [...tables.values()]
}

async function loadForeignKeys(query: Sql, schemas: readonly string[]): Promise<ForeignKey[]> {
  const result = await query(`
    select con.conname as name,
      src_ns.nspname as from_schema, src.relname as from_table,
      dst_ns.nspname as to_schema, dst.relname as to_table,
      (
        select array_agg(sa.attname order by u.ord)
        from unnest(con.conkey) with ordinality as u(attnum, ord)
        join pg_attribute sa on sa.attrelid = src.oid and sa.attnum = u.attnum
      ) as from_cols,
      (
        select array_agg(da.attname order by u.ord)
        from unnest(con.confkey) with ordinality as u(attnum, ord)
        join pg_attribute da on da.attrelid = dst.oid and da.attnum = u.attnum
      ) as to_cols
    from pg_constraint con
    join pg_class src on src.oid = con.conrelid
    join pg_namespace src_ns on src_ns.oid = src.relnamespace
    join pg_class dst on dst.oid = con.confrelid
    join pg_namespace dst_ns on dst_ns.oid = dst.relnamespace
    where con.contype = 'f'
      and src_ns.nspname = any($1::name[])
      and dst_ns.nspname = any($1::name[])
  `, [schemas])
  return result.rows.flatMap((row) => {
    if (!isRow(row) || !Array.isArray(row['from_cols']) || !Array.isArray(row['to_cols'])) return []
    return [{
      name: String(row['name']),
      fromSchema: String(row['from_schema']),
      fromTable: String(row['from_table']),
      fromCols: row['from_cols'].map(String),
      toSchema: String(row['to_schema']),
      toTable: String(row['to_table']),
      toCols: row['to_cols'].map(String),
    }]
  })
}

function buildSchema(tables: Table[], keys: ForeignKey[]): GraphQLSchema {
  const byKey = new Map(tables.map((table) => [`${table.schema}.${table.name}`, table]))
  const comparisons = new Map<string, GraphQLInputObjectType>()
  for (const [name, spec] of Object.entries(COMPARISONS)) {
    comparisons.set(name, new GraphQLInputObjectType({
      name: `${name}_comparison_exp`,
      fields: Object.fromEntries(spec.ops.map((op) => [op, {
        type: op === '_in' ? new GraphQLList(spec.scalar) : op === '_is_null' ? GraphQLBoolean : spec.scalar,
      }])),
    }))
  }
  const boolTypes = new Map<string, GraphQLInputObjectType>()
  const orderTypes = new Map<string, GraphQLInputObjectType>()
  const objectTypes = new Map<string, GraphQLObjectType>()
  for (const table of tables) {
    boolTypes.set(table.field, new GraphQLInputObjectType({
      name: `${table.field}_bool_exp`,
      fields: () => {
        const fields: Record<string, { type: GraphQLInputObjectType | GraphQLList<GraphQLInputObjectType> }> = {
          _and: { type: new GraphQLList(boolTypes.get(table.field)!) },
          _or: { type: new GraphQLList(boolTypes.get(table.field)!) },
          _not: { type: boolTypes.get(table.field)! },
        }
        for (const column of table.columns.values()) {
          const comparison = comparisons.get(scalarName(column.type))
          if (comparison) fields[column.name] = { type: comparison }
        }
        return fields
      },
    }))
    orderTypes.set(table.field, new GraphQLInputObjectType({
      name: `${table.field}_order_by`,
      fields: Object.fromEntries([...table.columns.keys()].map((name) => [name, { type: ORDER }])),
    }))
  }
  for (const table of tables) {
    objectTypes.set(table.field, new GraphQLObjectType({
      name: table.field,
      fields: () => {
        const fields: Record<string, GraphQLFieldConfig<Record<string, unknown>, Exec>> = {}
        for (const column of table.columns.values()) {
          fields[column.name] = { type: COMPARISONS[scalarName(column.type)]?.scalar ?? GraphQLString }
        }
        for (const link of linksFor(table, keys, byKey)) {
          const related = objectTypes.get(link.table.field)
          if (!related || fields[link.field]) continue
          fields[link.field] = {
            type: link.kind === 'array' ? new GraphQLList(new GraphQLNonNull(related)) : related,
            args: {
              where: { type: boolTypes.get(link.table.field)! },
              order_by: { type: new GraphQLList(new GraphQLNonNull(orderTypes.get(link.table.field)!)) },
              limit: { type: GraphQLInt },
              offset: { type: GraphQLInt },
            },
            resolve: (parent, args, exec) => loadRelated(exec, link, parent, args, numberDepth(parent) + 1),
          }
        }
        return fields
      },
    }))
  }
  const rootFields: Record<string, GraphQLFieldConfig<unknown, Exec>> = {}
  for (const table of tables) {
    const object = objectTypes.get(table.field)!
    const args = {
      where: { type: boolTypes.get(table.field)! },
      order_by: { type: new GraphQLList(new GraphQLNonNull(orderTypes.get(table.field)!)) },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
    }
    rootFields[table.field] = { type: new GraphQLList(new GraphQLNonNull(object)), args, resolve: (_parent, fieldArgs, exec) => selectRows(exec, table, fieldArgs, [], 1) }
    if (table.primary.length === 1) {
      const pk = table.primary[0]!
      const pkType = COMPARISONS[scalarName(table.columns.get(pk)?.type ?? 'text')]?.scalar ?? GraphQLString
      rootFields[`${table.field}_by_pk`] = {
        type: object,
        args: { [pk]: { type: new GraphQLNonNull(pkType) } },
        resolve: async (_parent, fieldArgs, exec) => {
          const rows = await selectRows(exec, table, { where: { [pk]: { _eq: fieldArgs[pk] } }, limit: 1 }, [], 1)
          return rows[0] ?? null
        },
      }
    }
  }
  if (Object.keys(rootFields).length === 0) {
    rootFields['_empty'] = { type: GraphQLBoolean, resolve: async () => true }
  }
  return new GraphQLSchema({ query: new GraphQLObjectType({ name: 'query_root', fields: rootFields }) })
}

type Link = { field: string; kind: 'object' | 'array'; table: Table; from: string[]; to: string[] }

function linksFor(table: Table, keys: ForeignKey[], byKey: Map<string, Table>): Link[] {
  const links: Link[] = []
  for (const key of keys) {
    if (key.fromSchema === table.schema && key.fromTable === table.name) {
      const target = byKey.get(`${key.toSchema}.${key.toTable}`)
      if (!target) continue
      const field = key.fromCols.length === 1 && key.fromCols[0]?.endsWith('_id')
        ? key.fromCols[0].slice(0, -3)
        : target.field
      if (graphqlName(field)) links.push({ field, kind: 'object', table: target, from: key.fromCols, to: key.toCols })
    }
    if (key.toSchema === table.schema && key.toTable === table.name) {
      const child = byKey.get(`${key.fromSchema}.${key.fromTable}`)
      if (!child) continue
      if (graphqlName(child.field)) links.push({ field: child.field, kind: 'array', table: child, from: key.toCols, to: key.fromCols })
    }
  }
  return links
}

async function loadRelated(exec: Exec, link: Link, parent: Record<string, unknown>, args: Record<string, unknown>, depth: number): Promise<unknown> {
  const extra = link.from.map((column, index) => ({ column: link.to[index]!, value: parent[column] }))
  const rows = await selectRows(exec, link.table, args, extra, depth)
  return link.kind === 'array' ? rows : rows[0] ?? null
}

async function selectRows(exec: Exec, table: Table, args: Record<string, unknown>, parent: Array<{ column: string; value: unknown }>, depth = exec.depth): Promise<Record<string, unknown>[]> {
  if (depth > MAX_DEPTH) throw new GraphQLError('GraphQL query is too deep.')
  try {
    const params: unknown[] = []
    const filters = parent.map((item) => {
      params.push(item.value)
      return `${quoteIdent('t')}.${quoteIdent(item.column)} = $${params.length}`
    })
    if (args['where'] !== undefined && args['where'] !== null) filters.push(compileBool(table, args['where'], params))
    const where = filters.length ? ` where ${filters.join(' and ')}` : ''
    const order = compileOrder(table, args['order_by'])
    let limit = ''
    if (args['limit'] !== undefined && args['limit'] !== null) {
      params.push(args['limit'])
      limit = ` limit $${params.length}`
    }
    let offset = ''
    if (args['offset'] !== undefined && args['offset'] !== null) {
      params.push(args['offset'])
      offset = ` offset $${params.length}`
    }
    const columns = [...table.columns.keys()].map((name) => `${quoteIdent('t')}.${quoteIdent(name)}`).join(', ')
    const result = await exec.query(
      `select ${columns} from ${quoteIdent(table.schema)}.${quoteIdent(table.name)} as ${quoteIdent('t')}${where}${order}${limit}${offset}`,
      params,
    )
    return result.rows.filter(isRecord).map((row) => ({ ...row, __depth: depth }))
  } catch (error) {
    if (error instanceof GraphQLError) throw error
    throw new GraphQLError('GraphQL execution failed.', { extensions: { code: 'GRAPHQL_EXECUTION_FAILED' } })
  }
}

function compileBool(table: Table, value: unknown, params: unknown[]): string {
  if (!isRecord(value)) throw new GraphQLError('GraphQL where clause is invalid.')
  const parts: string[] = []
  for (const [key, item] of Object.entries(value)) {
    if (key === '_and' || key === '_or') {
      if (!Array.isArray(item)) throw new GraphQLError('GraphQL where clause is invalid.')
      const joiner = key === '_and' ? ' and ' : ' or '
      parts.push(`(${item.map((entry) => compileBool(table, entry, params)).join(joiner) || (key === '_and' ? 'true' : 'false')})`)
    } else if (key === '_not') {
      parts.push(`(not ${compileBool(table, item, params)})`)
    } else if (table.columns.has(key)) {
      parts.push(compileComparison(`${quoteIdent('t')}.${quoteIdent(key)}`, item, params))
    } else {
      throw new GraphQLError(`GraphQL where clause cannot filter '${key}'. Relationship filters are not implemented.`)
    }
  }
  return parts.join(' and ') || 'true'
}

function compileComparison(sqlRef: string, value: unknown, params: unknown[]): string {
  if (!isRecord(value)) throw new GraphQLError('GraphQL comparison is invalid.')
  const parts: string[] = []
  for (const [op, item] of Object.entries(value)) {
    if (op === '_is_null') {
      parts.push(item === true ? `${sqlRef} is null` : `${sqlRef} is not null`)
    } else if (op === '_in') {
      if (!Array.isArray(item) || item.length === 0) {
        parts.push('false')
      } else {
        const marks = item.map((entry) => {
          params.push(entry)
          return `$${params.length}`
        })
        parts.push(`${sqlRef} in (${marks.join(', ')})`)
      }
    } else if (op === '_eq' && item === null) {
      parts.push(`${sqlRef} is null`)
    } else if (op === '_neq' && item === null) {
      parts.push(`${sqlRef} is not null`)
    } else if (['_eq', '_neq', '_gt', '_gte', '_lt', '_lte', '_like', '_ilike'].includes(op)) {
      params.push(item)
      const operator = op === '_eq' ? '=' : op === '_neq' ? '<>' : op === '_gt' ? '>' : op === '_gte' ? '>=' : op === '_lt' ? '<' : op === '_lte' ? '<=' : op === '_like' ? 'like' : 'ilike'
      parts.push(`${sqlRef} ${operator} $${params.length}`)
    } else {
      throw new GraphQLError(`GraphQL comparison '${op}' is not implemented.`)
    }
  }
  return parts.join(' and ') || 'true'
}

function compileOrder(table: Table, value: unknown): string {
  if (value === undefined || value === null) return ''
  if (!Array.isArray(value)) throw new GraphQLError('GraphQL order_by is invalid.')
  const terms: string[] = []
  for (const item of value) {
    if (!isRecord(item)) throw new GraphQLError('GraphQL order_by is invalid.')
    for (const [column, direction] of Object.entries(item)) {
      if (!table.columns.has(column) || typeof direction !== 'string') throw new GraphQLError('GraphQL order_by is invalid.')
      terms.push(`${quoteIdent('t')}.${quoteIdent(column)} ${direction}`)
    }
  }
  return terms.length ? ` order by ${terms.join(', ')}` : ''
}

function scalarName(type: string): string {
  if (['int2', 'int4', 'int8'].includes(type)) return 'Int'
  if (['float4', 'float8', 'numeric'].includes(type)) return 'Float'
  if (type === 'bool') return 'Boolean'
  return 'String'
}

function graphqlName(value: string): boolean {
  return /^[_A-Za-z][_0-9A-Za-z]*$/.test(value)
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function isRow(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function numberDepth(value: Record<string, unknown>): number {
  return typeof value['__depth'] === 'number' ? value['__depth'] : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isRow(value)
}
