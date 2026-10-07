/**
 * Schema snapshot + diff - the engine behind `supacloud-lite db diff`.
 *
 * Snapshots a schema (tables, columns, constraints, indexes, enums, views,
 * functions, triggers, and policies) into a
 * structured form, then emits the DDL to turn one snapshot into another. Used
 * to capture changes made outside migrations (e.g. in the Studio SQL editor)
 * into a new migration, the way `supabase db diff` (migra) does.
 *
 * Covered: enums (create + add value), tables (create/drop), columns
 * (add/drop/alter type/nullability/default), and named constraints + indexes
 * (add/drop by definition). Extended objects are compared for drift, but their
 * migration requires the official pg-delta adapter for dependency ordering.
 */
import { quoteIdent } from './database.js'
import type { DbEngine } from './engine.js'

interface ColumnSnap {
  name: string
  /** fully-specified type from format_type (e.g. `character varying(255)`) */
  type: string
  nullable: boolean
  /** column default expression, or null when none */
  default: string | null
}
interface TableSnap {
  name: string
  columns: Map<string, ColumnSnap>
  /** column names in declaration order, so DDL is emitted deterministically */
  order: string[]
}

type DefinitionMap = Map<string, string>

/** A structured snapshot of one schema, diffable into DDL by {@link diffSchemas}. */
export interface SchemaSnapshot {
  /** table name → its columns */
  tables: Map<string, TableSnap>
  /** table → (constraint name → definition from pg_get_constraintdef) */
  constraints: Map<string, Map<string, string>>
  /** table → (index name → definition from pg_get_indexdef), excluding constraint-backing indexes */
  indexes: Map<string, Map<string, string>>
  /** enum type name → its labels in sort order */
  enums: Map<string, string[]>
  /** view name → view definition */
  views: DefinitionMap
  /** function identity → function definition */
  functions: DefinitionMap
  /** table/name → trigger definition */
  triggers: DefinitionMap
  /** table/name → policy definition */
  policies: DefinitionMap
  /** Catalog attributes which table DDL must preserve, including grants and identity. */
  attributes: DefinitionMap
}

/** Snapshot a schema's tables, columns, constraints, indexes, and enums. */
export async function snapshotSchema(db: Pick<DbEngine, 'query'>, schema = 'public'): Promise<SchemaSnapshot> {
  const cols = await db.query<{ table: string; column: string; type: string; nullable: boolean; default: string | null }>(
    `select c.relname as table, a.attname as column,
            format_type(a.atttypid, a.atttypmod) as type,
            not a.attnotnull as nullable,
            pg_get_expr(d.adbin, d.adrelid) as default
     from pg_attribute a
     join pg_class c on c.oid = a.attrelid
     join pg_namespace n on n.oid = c.relnamespace
     left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
     where n.nspname = $1 and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
     order by c.relname, a.attnum`,
    [schema]
  )
  const tables = new Map<string, TableSnap>()
  for (const c of cols.rows) {
    let t = tables.get(c.table)
    if (!t) {
      t = { name: c.table, columns: new Map(), order: [] }
      tables.set(c.table, t)
    }
    t.columns.set(c.column, { name: c.column, type: c.type, nullable: c.nullable, default: c.default })
    t.order.push(c.column)
  }

  const cons = await db.query<{ table: string; name: string; def: string; conindid: number }>(
    `select c.relname as table, con.conname as name, pg_get_constraintdef(con.oid) as def, con.conindid::int as conindid
     from pg_constraint con
     join pg_class c on c.oid = con.conrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and con.contype in ('p','u','f','c')`,
    [schema]
  )
  const constraints = new Map<string, Map<string, string>>()
  const constraintIndexOids = new Set<number>()
  for (const c of cons.rows) {
    if (!constraints.has(c.table)) constraints.set(c.table, new Map())
    constraints.get(c.table)!.set(c.name, c.def)
    if (c.conindid) constraintIndexOids.add(c.conindid)
  }

  // indexes not backing a constraint (those are emitted via the constraint)
  const idx = await db.query<{ table: string; name: string; def: string; indexrelid: number }>(
    `select c.relname as table, ic.relname as name, pg_get_indexdef(i.indexrelid) as def, i.indexrelid::int as indexrelid
     from pg_index i
     join pg_class ic on ic.oid = i.indexrelid
     join pg_class c on c.oid = i.indrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1`,
    [schema]
  )
  const indexes = new Map<string, Map<string, string>>()
  for (const r of idx.rows) {
    if (constraintIndexOids.has(r.indexrelid)) continue
    if (!indexes.has(r.table)) indexes.set(r.table, new Map())
    indexes.get(r.table)!.set(r.name, r.def)
  }

  const en = await db.query<{ name: string; labels: string[] }>(
    `select t.typname as name, array_agg(e.enumlabel order by e.enumsortorder) as labels
     from pg_type t join pg_enum e on e.enumtypid = t.oid
     join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = $1 group by t.typname`,
    [schema]
  )
  const enums = new Map<string, string[]>()
  for (const r of en.rows) enums.set(r.name, r.labels)

  const viewRows = await db.query<{ name: string; definition: string }>(
    `select c.relname as name, c.relkind::text || ':' || pg_get_viewdef(c.oid, true) as definition
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relkind in ('v','m')
     order by c.relname`,
    [schema],
  )
  const views = new Map<string, string>()
  for (const row of viewRows.rows) views.set(row.name, row.definition)

  const functionRows = await db.query<{ identity: string; definition: string }>(
    `select n.nspname || '.' || p.proname || '(' ||
            pg_get_function_identity_arguments(p.oid) || ')' as identity,
            pg_get_functiondef(p.oid) as definition
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = $1 and p.prokind in ('f', 'p')
     order by p.proname, pg_get_function_identity_arguments(p.oid)`,
    [schema],
  )
  const functions = new Map<string, string>()
  for (const row of functionRows.rows) functions.set(row.identity, row.definition)

  const triggerRows = await db.query<{ table: string; name: string; definition: string }>(
    `select c.relname as table, t.tgname as name, pg_get_triggerdef(t.oid, true) as definition
     from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and not t.tgisinternal
     order by c.relname, t.tgname`,
    [schema],
  )
  const triggers = new Map<string, string>()
  for (const row of triggerRows.rows) triggers.set(`${row.table}.${row.name}`, row.definition)

  const policyRows = await db.query<{
    table: string
    name: string
    permissive: string
    roles: string[]
    command: string
    using_expression: string | null
    check_expression: string | null
  }>(
    `select tablename as table, policyname as name, permissive,
            roles, cmd as command, qual as using_expression,
            with_check as check_expression
     from pg_policies
     where schemaname = $1
     order by tablename, policyname`,
    [schema],
  )
  const policies = new Map<string, string>()
  for (const row of policyRows.rows) policies.set(`${row.table}.${row.name}`, renderPolicy(schema, row))

  const attributesRows = await db.query<{ name: string; definition: string }>(
    `select 'relation/' || c.relname as name,
            jsonb_build_array(c.relkind, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity,
              c.relispartition, pg_get_expr(c.relpartbound, c.oid),
              pg_get_partkeydef(c.oid), pg_get_userbyid(c.relowner),
              c.relacl::text, c.reloptions)::text as definition
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relkind in ('r','p','v','m','S','f')
     union all
     select 'column/' || c.relname || '/' || a.attname,
            jsonb_build_array(a.attidentity, a.attgenerated, a.attacl::text,
              a.attcollation::regcollation::text)::text
     from pg_attribute a join pg_class c on c.oid = a.attrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped
     union all
     select 'function/' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
            jsonb_build_array(pg_get_userbyid(p.proowner), p.proacl::text)::text
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = $1 and p.prokind in ('f','p')
     union all
     select 'schema/' || n.nspname,
            jsonb_build_array(pg_get_userbyid(n.nspowner), n.nspacl::text)::text
     from pg_namespace n where n.nspname = $1
     union all
     select 'sequence/' || c.relname,
            jsonb_build_array(s.seqtypid::regtype::text, s.seqstart, s.seqincrement,
              s.seqmax, s.seqmin, s.seqcache, s.seqcycle)::text
     from pg_sequence s join pg_class c on c.oid = s.seqrelid
     join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1
     union all
     select 'trigger/' || c.relname || '/' || t.tgname, t.tgenabled::text
     from pg_trigger t join pg_class c on c.oid = t.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and not t.tgisinternal
     union all
     select 'type/' || t.typname,
            jsonb_build_array(t.typtype, t.typbasetype::regtype::text, t.typtypmod,
              t.typnotnull, t.typdefault, t.typacl::text,
              (select array_agg(pg_get_constraintdef(con.oid) order by con.conname)
               from pg_constraint con where con.contypid = t.oid))::text
     from pg_type t join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = $1 and t.typtype in ('d','r','m')
     union all
     select 'defaults/' || pg_get_userbyid(d.defaclrole) || '/' || d.defaclobjtype::text,
            d.defaclacl::text
     from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace where n.nspname = $1`,
    [schema],
  )
  const attributes = new Map(attributesRows.rows.map(row => [row.name, row.definition]))
  return { tables, constraints, indexes, enums, views, functions, triggers, policies, attributes }
}

export function schemasEqual(left: SchemaSnapshot, right: SchemaSnapshot): boolean {
  const canonical = (value: unknown): unknown => {
    if (value instanceof Map) return [...value].sort(([a], [b]) => String(a).localeCompare(String(b)))
      .map(([key, entry]) => [key, canonical(entry)])
    if (Array.isArray(value)) return value.map(canonical)
    if (value !== null && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]),
    )
    return value
  }
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

/** DDL to turn `from` into `to`, scoped to one schema. Empty array = no changes. */
export function diffSchemas(from: SchemaSnapshot, to: SchemaSnapshot, schema = 'public'): string[] {
  for (const [key, value] of from.attributes) {
    if (to.attributes.has(key) && to.attributes.get(key) !== value) {
      throw new Error('Lite table diff cannot safely migrate catalog attributes; use the official Supabase pg-delta adapter')
    }
  }
  for (const [name, labels] of from.enums) {
    const next = to.enums.get(name)
    if (!next || labels.some((label, index) => next[index] !== label)) {
      throw new Error('Lite table diff only supports appending enum values; use the official Supabase pg-delta adapter')
    }
  }
  for (const kind of ['views', 'functions', 'triggers', 'policies'] as const) {
    if (from[kind].size !== to[kind].size
      || [...from[kind]].some(([name, definition]) => to[kind].get(name) !== definition)) {
      throw new Error(`Lite table diff cannot safely migrate ${kind}; use the official Supabase pg-delta adapter`)
    }
  }
  const out: string[] = []
  const q = (n: string) => quoteIdent(n)
  const tbl = (t: string) => `${q(schema)}.${q(t)}`

  // ── enums ──
  for (const [name, labels] of to.enums) {
    if (!from.enums.has(name)) {
      out.push(`create type ${q(schema)}.${q(name)} as enum (${labels.map((l) => `'${l.replace(/'/g, "''")}'`).join(', ')});`)
    } else {
      const before = from.enums.get(name)!
      for (const label of labels) {
        if (!before.includes(label)) out.push(`alter type ${q(schema)}.${q(name)} add value '${label.replace(/'/g, "''")}';`)
      }
    }
  }

  // ── new tables ──
  for (const [name, t] of to.tables) {
    if (from.tables.has(name)) continue
    const colDefs = t.order.map((cn) => columnClause(t.columns.get(cn)!, q))
    out.push(`create table ${tbl(name)} (\n${colDefs.map((c) => `  ${c}`).join(',\n')}\n);`)
  }

  // ── column-level diffs on shared tables ──
  for (const [name, toT] of to.tables) {
    const fromT = from.tables.get(name)
    if (!fromT) continue
    for (const cn of toT.order) {
      const toC = toT.columns.get(cn)!
      const fromC = fromT.columns.get(cn)
      if (!fromC) {
        out.push(`alter table ${tbl(name)} add column ${columnClause(toC, q)};`)
        continue
      }
      if (fromC.type !== toC.type) out.push(`alter table ${tbl(name)} alter column ${q(cn)} type ${toC.type};`)
      if (fromC.nullable !== toC.nullable)
        out.push(`alter table ${tbl(name)} alter column ${q(cn)} ${toC.nullable ? 'drop not null' : 'set not null'};`)
      if ((fromC.default ?? null) !== (toC.default ?? null)) {
        out.push(
          toC.default === null
            ? `alter table ${tbl(name)} alter column ${q(cn)} drop default;`
            : `alter table ${tbl(name)} alter column ${q(cn)} set default ${toC.default};`
        )
      }
    }
    for (const cn of fromT.order) {
      if (!toT.columns.has(cn)) out.push(`alter table ${tbl(name)} drop column ${q(cn)};`)
    }
  }

  // ── dropped tables ──
  // `drop table` cascades the table's own constraints and indexes, so the
  // constraint/index diffs below must skip anything on a table dropped here -
  // otherwise they emit `alter table … drop constraint` against a table that no
  // longer exists, and the generated migration fails to apply.
  const droppedTables = new Set<string>()
  for (const name of from.tables.keys()) {
    if (!to.tables.has(name)) {
      out.push(`drop table ${tbl(name)};`)
      droppedTables.add(name)
    }
  }

  // ── constraints (drop changed/removed, then add new) ──
  diffNamed(from.constraints, to.constraints, {
    drop: (table, cname) => {
      if (!droppedTables.has(table)) out.push(`alter table ${tbl(table)} drop constraint ${q(cname)};`)
    },
    add: (table, cname, def) => out.push(`alter table ${tbl(table)} add constraint ${q(cname)} ${def};`),
  })

  // ── indexes (drop changed/removed, then add new) ──
  diffNamed(from.indexes, to.indexes, {
    drop: (table, iname) => {
      if (!droppedTables.has(table)) out.push(`drop index ${q(schema)}.${q(iname)};`)
    },
    add: (_table, _iname, def) => out.push(`${def};`),
  })

  return out
}

function renderPolicy(
  schema: string,
  row: {
    table: string
    name: string
    permissive: string
    roles: string[]
    command: string
    using_expression: string | null
    check_expression: string | null
  },
): string {
  const roles = row.roles.length ? row.roles.map((role) => quoteIdent(role)).join(', ') : 'public'
  const command = row.command.toLowerCase() === '*' ? 'all' : row.command.toLowerCase()
  const mode = row.permissive.toLowerCase() === 'permissive' ? 'permissive' : 'restrictive'
  let sql = `create policy ${quoteIdent(row.name)} on ${quoteIdent(schema)}.${quoteIdent(row.table)} as ${mode} for ${command} to ${roles}`
  if (row.using_expression) sql += ` using (${row.using_expression})`
  if (row.check_expression) sql += ` with check (${row.check_expression})`
  return sql
}

/**
 * Render a column definition. A `serial`-style column introspects as an integer
 * with a `nextval('..._seq')` default and an owned sequence; re-emit it as
 * serial/bigserial/smallserial so the sequence is recreated with the table
 * (a bare `default nextval(...)` would reference a sequence that doesn't exist yet).
 */
function columnClause(c: ColumnSnap, q: (n: string) => string): string {
  const isSerialDefault = c.default !== null && /^nextval\(/i.test(c.default)
  if (isSerialDefault) {
    const serial = c.type === 'bigint' ? 'bigserial' : c.type === 'smallint' ? 'smallserial' : 'serial'
    return `${q(c.name)} ${serial}` + (c.nullable ? '' : ' not null')
  }
  let s = `${q(c.name)} ${c.type}`
  if (!c.nullable) s += ' not null'
  if (c.default !== null) s += ` default ${c.default}`
  return s
}

function diffNamed(
  from: Map<string, Map<string, string>>,
  to: Map<string, Map<string, string>>,
  ops: { drop: (table: string, name: string, def: string) => void; add: (table: string, name: string, def: string) => void }
): void {
  // drops (and changed → drop first)
  for (const [table, defs] of from) {
    const toDefs = to.get(table) ?? new Map()
    for (const [name, def] of defs) {
      const toDef = toDefs.get(name)
      if (toDef === undefined || toDef !== def) ops.drop(table, name, def)
    }
  }
  // adds (and changed → re-add)
  for (const [table, defs] of to) {
    const fromDefs = from.get(table) ?? new Map()
    for (const [name, def] of defs) {
      const fromDef = fromDefs.get(name)
      if (fromDef === undefined || fromDef !== def) ops.add(table, name, def)
    }
  }
}
