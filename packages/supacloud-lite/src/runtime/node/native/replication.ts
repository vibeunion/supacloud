import { existsSync, statSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { resolve } from 'node:path'
import type { DbEngine, EngineTx } from '../../db/engine.js'

export const POWERSYNC_REPLICATION_ROLE = 'supacloud_powersync'
export const POWERSYNC_PUBLICATION = 'powersync'

export interface NativeReplicationTlsOptions {
  certFile: string
  keyFile: string
}

export interface PowerSyncReplicationOptions {
  profile: 'powersync'
  host: string
  port: number
  allowCidrs: string[]
  publicationTables: string[]
  password: string
  tls?: NativeReplicationTlsOptions
}

export type NativeReplicationOptions = PowerSyncReplicationOptions

export function validatePowerSyncReplicationOptions(
  options: PowerSyncReplicationOptions,
): PowerSyncReplicationOptions {
  const host = options.host.trim()
  validateConnectionInput(host, options.port, options.password)
  const publicationTables = uniqueSorted(options.publicationTables.map(normalizeQualifiedTable))
  const allowCidrs = uniqueSorted(options.allowCidrs.map(normalizeCidr))
  validateAllowlists(publicationTables, allowCidrs)
  validateNetworkBoundary(host, allowCidrs, Boolean(options.tls))
  const tls = options.tls ? validateTlsOptions(options.tls) : undefined
  return { ...options, host, allowCidrs, publicationTables, tls }
}

export function buildPowerSyncPostgresArgs(options: PowerSyncReplicationOptions, hbaFile: string): string[] {
  const validated = validatePowerSyncReplicationOptions(options)
  const args = [
    '-c', `listen_addresses=${validated.host}`,
    '-c', `port=${validated.port}`,
    '-c', 'wal_level=logical',
    '-c', 'max_wal_senders=4',
    '-c', 'max_replication_slots=4',
    '-c', 'max_slot_wal_keep_size=1024MB',
    '-c', 'wal_keep_size=64MB',
    '-c', `hba_file=${resolve(hbaFile)}`,
  ]
  if (!validated.tls) return [...args, '-c', 'ssl=off']
  args.push(
    '-c', 'ssl=on',
    '-c', `ssl_cert_file=${validated.tls.certFile}`,
    '-c', `ssl_key_file=${validated.tls.keyFile}`,
  )
  return args
}

export function writePowerSyncHba(path: string, options: PowerSyncReplicationOptions): void {
  const validated = validatePowerSyncReplicationOptions(options)
  const hostRecord = validated.tls ? 'hostssl' : 'host'
  const lines = [
    '# Managed by SupaCloud Lite. Changes are replaced when the PowerSync profile starts.',
    'local all postgres trust',
    ...validated.allowCidrs.flatMap((cidr) => [
      `${hostRecord} postgres ${POWERSYNC_REPLICATION_ROLE} ${cidr} scram-sha-256`,
      `${hostRecord} replication ${POWERSYNC_REPLICATION_ROLE} ${cidr} scram-sha-256`,
    ]),
    'host all all 0.0.0.0/0 reject',
    'host all all ::/0 reject',
    '',
  ]
  writeFileSync(path, lines.join('\n'), { mode: 0o600 })
}

export async function ensurePowerSyncReplicationCatalog(
  engine: DbEngine,
  options: PowerSyncReplicationOptions,
): Promise<void> {
  const validated = validatePowerSyncReplicationOptions(options)
  await engine.transaction(async (tx) => {
    const tables = await inspectPublicationTables(tx, validated.publicationTables)
    validatePublicationTables(tables)
    await configureReplicationRole(tx, validated.password)
    await synchronizeReplicationGrants(tx, tables)
    await assertEffectiveSelectAllowlist(tx, tables)
    await synchronizePublication(tx, tables)
  })
}

function validatePublicationTables(tables: readonly PublicationTableInspection[]): void {
  const missing = tables.filter((table) => !table.present).map((table) => table.name)
  if (missing.length > 0) {
    throw new Error(`PowerSync publication tables do not exist: ${missing.join(', ')}`)
  }
  const unsupported = tables.filter((table) => table.present && !['r', 'p'].includes(table.relkind ?? ''))
  if (unsupported.length > 0) {
    throw new Error(`PowerSync publication only accepts ordinary or partitioned tables: ${unsupported.map((table) => table.name).join(', ')}`)
  }
}

async function configureReplicationRole(tx: EngineTx, passwordValue: string): Promise<void> {
  await tx.exec(`
    DO $profile$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${POWERSYNC_REPLICATION_ROLE}') THEN
        CREATE ROLE ${POWERSYNC_REPLICATION_ROLE};
      END IF;
    END
    $profile$;
    ALTER ROLE ${POWERSYNC_REPLICATION_ROLE}
      WITH LOGIN NOINHERIT REPLICATION BYPASSRLS CONNECTION LIMIT 4 PASSWORD ${quoteLiteral(passwordValue)};
    ALTER ROLE ${POWERSYNC_REPLICATION_ROLE} SET search_path = pg_catalog;
    GRANT CONNECT ON DATABASE postgres TO ${POWERSYNC_REPLICATION_ROLE};
  `)
}

async function synchronizeReplicationGrants(
  tx: EngineTx,
  tables: readonly PublicationTableInspection[],
): Promise<void> {
  await revokeReplicationGrants(tx)
  await grantReplicationAllowlist(tx, tables)
}

async function revokeReplicationGrants(tx: EngineTx): Promise<void> {
  const staleGrants = await tx.query<{ table_schema: string; table_name: string }>(`
    SELECT DISTINCT table_schema, table_name
    FROM information_schema.role_table_grants
    WHERE grantee = '${POWERSYNC_REPLICATION_ROLE}' AND privilege_type = 'SELECT'
  `)
  for (const grant of staleGrants.rows) {
    await tx.exec(
      `REVOKE SELECT ON TABLE ${quoteIdentifier(grant.table_schema)}.${quoteIdentifier(grant.table_name)} ` +
      `FROM ${POWERSYNC_REPLICATION_ROLE}`
    )
  }

  const applicationSchemas = await tx.query<{ schema_name: string }>(`
    SELECT nspname AS schema_name
    FROM pg_namespace
    WHERE nspname NOT IN ('pg_catalog', 'information_schema')
      AND nspname !~ '^pg_toast'
  `)
  for (const schema of applicationSchemas.rows) {
    await tx.exec(`REVOKE USAGE ON SCHEMA ${quoteIdentifier(schema.schema_name)} FROM ${POWERSYNC_REPLICATION_ROLE}`)
  }
}

async function grantReplicationAllowlist(
  tx: EngineTx,
  tables: readonly PublicationTableInspection[],
): Promise<void> {
  const schemas = uniqueSorted(tables.map((table) => table.schema!))
  for (const schema of schemas) {
    await tx.exec(`GRANT USAGE ON SCHEMA ${quoteIdentifier(schema)} TO ${POWERSYNC_REPLICATION_ROLE}`)
  }
  for (const table of tables) {
    await tx.exec(`GRANT SELECT ON TABLE ${quoteQualifiedTable(table.name)} TO ${POWERSYNC_REPLICATION_ROLE}`)
  }
}

async function assertEffectiveSelectAllowlist(
  tx: EngineTx,
  tables: readonly PublicationTableInspection[],
): Promise<void> {
  const allowed = new Set(tables.map((table) => table.name))
  const selectable = await tx.query<{ qualified_name: string }>(`
    SELECT namespace.nspname || '.' || relation.relname AS qualified_name
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE relation.relkind IN ('r', 'p')
      AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND namespace.nspname !~ '^pg_toast'
      AND has_table_privilege('${POWERSYNC_REPLICATION_ROLE}', relation.oid, 'SELECT')
    ORDER BY namespace.nspname, relation.relname
  `)
  const outsideAllowlist = selectable.rows.map((row) => row.qualified_name)
    .filter((table) => !allowed.has(table))
  if (outsideAllowlist.length > 0) {
    throw new Error(`PowerSync role has SELECT outside the publication allowlist: ${outsideAllowlist.join(', ')}`)
  }
}

async function synchronizePublication(tx: EngineTx, tables: readonly PublicationTableInspection[]): Promise<void> {
  const publication = await tx.query<{ puballtables: boolean }>(
    `SELECT puballtables FROM pg_publication WHERE pubname = '${POWERSYNC_PUBLICATION}'`
  )
  if (publication.rows[0]?.puballtables) {
    throw new Error('existing powersync publication uses FOR ALL TABLES; replace it with an explicit allowlist')
  }
  if (publication.rows.length === 0) {
    await tx.exec(`CREATE PUBLICATION ${POWERSYNC_PUBLICATION} WITH (publish = 'insert, update, delete')`)
  }
  await tx.exec(
    `ALTER PUBLICATION ${POWERSYNC_PUBLICATION} SET TABLE ${tables.map((table) => quoteQualifiedTable(table.name)).join(', ')}; ` +
    `ALTER PUBLICATION ${POWERSYNC_PUBLICATION} SET (publish = 'insert, update, delete')`
  )
}

interface PublicationTableInspection {
  name: string
  schema?: string
  relkind?: string
  present: boolean
}

async function inspectPublicationTables(
  tx: EngineTx,
  names: readonly string[],
): Promise<PublicationTableInspection[]> {
  const rows: PublicationTableInspection[] = []
  for (const name of names) {
    const tableLookup = await tx.query<{ schema_name: string; relkind: string }>(`
      SELECT namespace.nspname AS schema_name, relation.relkind
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE relation.oid = to_regclass($1)
    `, [name])
    const row = tableLookup.rows[0]
    rows.push({ name, schema: row?.schema_name, relkind: row?.relkind, present: Boolean(row) })
  }
  return rows
}

function validateConnectionInput(host: string, port: number, password: string): void {
  if (!host || (host !== 'localhost' && isIP(host) === 0)) {
    throw new Error('PowerSync replication host must be localhost or an explicit IP address')
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PowerSync replication port must be between 1 and 65535')
  }
  if (password.length < 32) {
    throw new Error('SUPACLOUD_LITE_POWERSYNC_PASSWORD must contain at least 32 characters')
  }
  if (password.includes('\0')) throw new Error('SUPACLOUD_LITE_POWERSYNC_PASSWORD must not contain NUL bytes')
}

function validateAllowlists(publicationTables: string[], allowCidrs: string[]): void {
  if (publicationTables.length === 0) {
    throw new Error('PowerSync replication requires an explicit publication table allowlist')
  }
  if (allowCidrs.length === 0) throw new Error('PowerSync replication requires at least one client CIDR')
}

function validateNetworkBoundary(host: string, allowCidrs: string[], tls: boolean): void {
  if (!isLoopbackHost(host) && !tls) {
    throw new Error('non-loopback PowerSync replication requires TLS certificate and key files')
  }
  if (!tls && allowCidrs.some((cidr) => !isLoopbackCidr(cidr))) {
    throw new Error('non-loopback PowerSync client CIDRs require TLS')
  }
}

function validateTlsOptions(options: NativeReplicationTlsOptions): NativeReplicationTlsOptions {
  const tls = {
    certFile: resolve(options.certFile),
    keyFile: resolve(options.keyFile),
  }
  for (const path of [tls.certFile, tls.keyFile]) {
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`PowerSync TLS file does not exist: ${path}`)
  }
  if ((statSync(tls.keyFile).mode & 0o077) !== 0) {
    throw new Error('PowerSync TLS private key must not be readable by group or other users')
  }
  return tls
}

function normalizeQualifiedTable(tableName: string): string {
  const normalized = tableName.trim().toLowerCase()
  if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(normalized)) {
    throw new Error(`invalid PowerSync publication table: ${tableName}`)
  }
  return normalized
}

function normalizeCidr(cidr: string): string {
  const normalized = cidr.trim()
  const match = /^(.+)\/(\d{1,3})$/.exec(normalized)
  if (!match) throw new Error(`invalid PowerSync client CIDR: ${cidr}`)
  const address = match[1]!
  const family = isIP(address)
  const prefix = Number(match[2])
  if (family === 0 || prefix < 0 || prefix > (family === 4 ? 32 : 128)) {
    throw new Error(`invalid PowerSync client CIDR: ${cidr}`)
  }
  return `${address}/${prefix}`
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function isLoopbackCidr(cidr: string): boolean {
  return cidr === '127.0.0.1/32' || cidr === '::1/128'
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function quoteQualifiedTable(tableName: string): string {
  return tableName.split('.').map(quoteIdentifier).join('.')
}

function quoteLiteral(literal: string): string {
  return `'${literal.replaceAll("'", "''")}'`
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}
