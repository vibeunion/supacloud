import type { DbEngine } from '../../db/engine.js'
import {
  POWERSYNC_PUBLICATION,
  POWERSYNC_REPLICATION_ROLE,
  type PowerSyncReplicationOptions,
} from './replication.js'

export type LiteCapabilityStatus = 'supported' | 'static' | 'disabled' | 'unsupported'

export interface LiteDoctorReport {
  engine: 'pglite' | 'native'
  state_machine_sql: 'supported'
  durable_workflows: 'supported'
  commands: 'supported'
  artifacts: 'supported'
  postgrest_schema_config: 'static'
  logical_replication: LiteCapabilityStatus
  powersync_source: LiteCapabilityStatus
  replication_profile?: 'powersync'
  powersync_readiness?: PowerSyncReadiness
}

export interface PowerSyncReadiness {
  ready: boolean
  blockers: string[]
  warnings: string[]
  connection: {
    host: string
    port: number
    tls: boolean
    allowed_cidrs: string[]
  }
  wal: {
    level: string
    max_senders: number
    active_senders: number
    max_replication_slots: number
    used_replication_slots: number
    max_slot_wal_keep_size: string
  }
  role: {
    name: string
    present: boolean
    login: boolean
    replication: boolean
    bypass_rls: boolean
    unexpected_selectable_tables: string[]
  }
  publication: {
    name: string
    present: boolean
    all_tables: boolean
    tables: string[]
    expected_tables: string[]
    publishes_insert: boolean
    publishes_update: boolean
    publishes_delete: boolean
    replica_identity_missing_tables: string[]
  }
  slots: Array<{
    name: string
    active: boolean
    wal_status: string | null
    retained_wal_bytes: string
    unconfirmed_wal_bytes: string
    safe_wal_size: string | null
    invalidation_reason: string | null
  }>
}

export function liteCapabilities(
  engine: 'pglite' | 'native',
  replicationProfile?: 'powersync',
): LiteDoctorReport {
  if (engine === 'pglite') {
    return {
      engine,
      state_machine_sql: 'supported',
      durable_workflows: 'supported',
      commands: 'supported',
      artifacts: 'supported',
      postgrest_schema_config: 'static',
      logical_replication: 'unsupported',
      powersync_source: 'unsupported',
    }
  }
  return {
    engine,
    state_machine_sql: 'supported',
    durable_workflows: 'supported',
    commands: 'supported',
    artifacts: 'supported',
    postgrest_schema_config: 'static',
    logical_replication: replicationProfile ? 'supported' : 'disabled',
    powersync_source: replicationProfile ? 'supported' : 'disabled',
    ...(replicationProfile ? { replication_profile: replicationProfile } : {}),
  }
}

export async function inspectPowerSyncReadiness(
  engine: DbEngine,
  options: PowerSyncReplicationOptions,
): Promise<PowerSyncReadiness> {
  return buildReadiness(await loadReplicationInventory(engine), options)
}

interface ReplicationRoleRow {
  rolcanlogin: boolean
  rolreplication: boolean
  rolbypassrls: boolean
}

interface ReplicationPublicationRow {
  puballtables: boolean
  pubinsert: boolean
  pubupdate: boolean
  pubdelete: boolean
}

interface ReplicationPublicationTableRow {
  qualified_name: string
  replica_identity_missing: boolean
}

interface ReplicationSlotRow {
  slot_name: string
  active: boolean
  wal_status: string | null
  retained_wal_bytes: string
  unconfirmed_wal_bytes: string
  safe_wal_size: string | null
  invalidation_reason: string | null
}

interface ReplicationInventory {
  settings: Map<string, string>
  activeSenders: number
  role?: ReplicationRoleRow
  publication?: ReplicationPublicationRow
  publicationTables: ReplicationPublicationTableRow[]
  selectableTables: string[]
  slots: ReplicationSlotRow[]
}

async function loadReplicationInventory(engine: DbEngine): Promise<ReplicationInventory> {
  const [settings, senders, role, publication, publicationTables, selectableTables, slots] = await Promise.all([
    engine.query<{ name: string; setting: string }>(`
      SELECT name, setting
      FROM pg_settings
      WHERE name IN (
        'wal_level', 'max_wal_senders', 'max_replication_slots',
        'max_slot_wal_keep_size', 'ssl', 'listen_addresses', 'port'
      )
    `),
    engine.query<{ count: number }>('SELECT count(*)::integer AS count FROM pg_stat_replication'),
    engine.query<{ rolcanlogin: boolean; rolreplication: boolean; rolbypassrls: boolean }>(`
      SELECT rolcanlogin, rolreplication, rolbypassrls
      FROM pg_roles WHERE rolname = '${POWERSYNC_REPLICATION_ROLE}'
    `),
    engine.query<ReplicationPublicationRow>(`
      SELECT puballtables, pubinsert, pubupdate, pubdelete
      FROM pg_publication WHERE pubname = '${POWERSYNC_PUBLICATION}'
    `),
    engine.query<ReplicationPublicationTableRow>(`
      SELECT
        quote_ident(namespace.nspname) || '.' || quote_ident(relation.relname) AS qualified_name,
        relation.relreplident = 'n' OR (
          relation.relreplident = 'd'
          AND NOT EXISTS (
            SELECT 1 FROM pg_index index_record
            WHERE index_record.indrelid = relation.oid AND index_record.indisprimary
          )
        ) AS replica_identity_missing
      FROM pg_publication_tables published
      JOIN pg_namespace namespace ON namespace.nspname = published.schemaname
      JOIN pg_class relation
        ON relation.relnamespace = namespace.oid AND relation.relname = published.tablename
      WHERE published.pubname = '${POWERSYNC_PUBLICATION}'
      ORDER BY namespace.nspname, relation.relname
    `),
    engine.query<{ qualified_name: string }>(`
      SELECT namespace.nspname || '.' || relation.relname AS qualified_name
      FROM pg_roles role_record
      JOIN pg_class relation ON true
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE role_record.rolname = '${POWERSYNC_REPLICATION_ROLE}'
        AND relation.relkind IN ('r', 'p')
        AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
        AND namespace.nspname !~ '^pg_toast'
        AND has_table_privilege(role_record.oid, relation.oid, 'SELECT')
      ORDER BY namespace.nspname, relation.relname
    `),
    engine.query<ReplicationSlotRow>(`
      SELECT
        slot_name,
        active,
        wal_status,
        coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn), 0)::text AS retained_wal_bytes,
        coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn), 0)::text AS unconfirmed_wal_bytes,
        safe_wal_size::text,
        invalidation_reason
      FROM pg_replication_slots
      WHERE slot_type = 'logical'
      ORDER BY slot_name
    `),
  ])
  return {
    settings: new Map(settings.rows.map((row) => [row.name, row.setting])),
    activeSenders: senders.rows[0]?.count ?? 0,
    role: role.rows[0],
    publication: publication.rows[0],
    publicationTables: publicationTables.rows,
    selectableTables: selectableTables.rows.map((row) => row.qualified_name),
    slots: slots.rows,
  }
}

function buildReadiness(
  inventory: ReplicationInventory,
  options: PowerSyncReplicationOptions,
): PowerSyncReadiness {
  const actualTables = catalogTableNames(inventory.publicationTables)
  const expectedTables = [...options.publicationTables].sort()
  const missingIdentity = missingReplicaIdentity(inventory.publicationTables)
  const blockers = readinessBlockers(inventory, actualTables, expectedTables, missingIdentity)
  return {
    ready: blockers.length === 0,
    blockers,
    warnings: readinessWarnings(inventory),
    connection: {
      host: options.host,
      port: options.port,
      tls: Boolean(options.tls),
      allowed_cidrs: options.allowCidrs,
    },
    wal: {
      level: inventory.settings.get('wal_level') ?? 'unknown',
      max_senders: integerSetting(inventory.settings.get('max_wal_senders')),
      active_senders: inventory.activeSenders,
      max_replication_slots: integerSetting(inventory.settings.get('max_replication_slots')),
      used_replication_slots: inventory.slots.length,
      max_slot_wal_keep_size: inventory.settings.get('max_slot_wal_keep_size') ?? 'unknown',
    },
    role: roleReadiness(inventory.role, unexpectedSelectableTables(inventory, expectedTables)),
    publication: publicationReadiness(inventory.publication, actualTables, expectedTables, missingIdentity),
    slots: inventory.slots.map((slot) => ({
      name: slot.slot_name,
      active: slot.active,
      wal_status: slot.wal_status,
      retained_wal_bytes: slot.retained_wal_bytes,
      unconfirmed_wal_bytes: slot.unconfirmed_wal_bytes,
      safe_wal_size: slot.safe_wal_size,
      invalidation_reason: slot.invalidation_reason,
    })),
  }
}

function readinessBlockers(
  inventory: ReplicationInventory,
  actualTables: readonly string[],
  expectedTables: readonly string[],
  missingIdentity: readonly string[],
): string[] {
  const blockers = capacityBlockers(inventory)
  if (!roleIsReady(inventory.role)) blockers.push('POWERSYNC_ROLE_NOT_READY')
  if (unexpectedSelectableTables(inventory, expectedTables).length > 0) {
    blockers.push('POWERSYNC_ROLE_SELECT_OUTSIDE_ALLOWLIST')
  }
  blockers.push(...publicationBlockers(inventory.publication, actualTables, expectedTables, missingIdentity))
  return blockers
}

function capacityBlockers(inventory: ReplicationInventory): string[] {
  const blockers: string[] = []
  const maxSenders = integerSetting(inventory.settings.get('max_wal_senders'))
  const maxSlots = integerSetting(inventory.settings.get('max_replication_slots'))
  if (inventory.settings.get('wal_level') !== 'logical') blockers.push('WAL_LEVEL_NOT_LOGICAL')
  if (maxSenders - inventory.activeSenders < 1) blockers.push('NO_FREE_WAL_SENDER')
  if (maxSlots - inventory.slots.length < 1) blockers.push('NO_FREE_REPLICATION_SLOT')
  return blockers
}

function publicationBlockers(
  publication: ReplicationPublicationRow | undefined,
  actualTables: readonly string[],
  expectedTables: readonly string[],
  missingIdentity: readonly string[],
): string[] {
  if (!publication) return ['POWERSYNC_PUBLICATION_MISSING']
  const blockers: string[] = []
  if (publication.puballtables) blockers.push('POWERSYNC_PUBLICATION_NOT_ALLOWLISTED')
  if (!publication.pubinsert || !publication.pubupdate || !publication.pubdelete) {
    blockers.push('POWERSYNC_PUBLICATION_DML_INCOMPLETE')
  }
  if (!sameStrings(actualTables, expectedTables)) blockers.push('POWERSYNC_PUBLICATION_TABLE_MISMATCH')
  if (missingIdentity.length > 0) blockers.push('POWERSYNC_REPLICA_IDENTITY_INCOMPLETE')
  return blockers
}

function readinessWarnings(inventory: ReplicationInventory): string[] {
  const warnings: string[] = []
  if (inventory.settings.get('max_slot_wal_keep_size') === '-1') warnings.push('SLOT_WAL_KEEP_SIZE_UNBOUNDED')
  if (inventory.slots.some((slot) => slot.wal_status === 'lost' || slot.invalidation_reason)) {
    warnings.push('INVALID_LOGICAL_SLOTS')
  }
  return warnings
}

function roleIsReady(role: ReplicationRoleRow | undefined): boolean {
  return Boolean(role?.rolcanlogin && role.rolreplication && role.rolbypassrls)
}

function roleReadiness(
  role: ReplicationRoleRow | undefined,
  unexpectedTables: string[],
): PowerSyncReadiness['role'] {
  return {
    name: POWERSYNC_REPLICATION_ROLE,
    present: Boolean(role),
    login: role?.rolcanlogin ?? false,
    replication: role?.rolreplication ?? false,
    bypass_rls: role?.rolbypassrls ?? false,
    unexpected_selectable_tables: unexpectedTables,
  }
}

function unexpectedSelectableTables(
  inventory: ReplicationInventory,
  expectedTables: readonly string[],
): string[] {
  const expected = new Set(expectedTables)
  return inventory.selectableTables.filter((table) => !expected.has(table))
}

function publicationReadiness(
  publication: ReplicationPublicationRow | undefined,
  tables: string[],
  expectedTables: string[],
  missingIdentity: string[],
): PowerSyncReadiness['publication'] {
  return {
    name: POWERSYNC_PUBLICATION,
    present: Boolean(publication),
    all_tables: publication?.puballtables ?? false,
    tables,
    expected_tables: expectedTables,
    publishes_insert: publication?.pubinsert ?? false,
    publishes_update: publication?.pubupdate ?? false,
    publishes_delete: publication?.pubdelete ?? false,
    replica_identity_missing_tables: missingIdentity,
  }
}

function catalogTableNames(rows: readonly ReplicationPublicationTableRow[]): string[] {
  return rows.map((row) => normalizeCatalogTable(row.qualified_name))
}

function missingReplicaIdentity(rows: readonly ReplicationPublicationTableRow[]): string[] {
  return rows.filter((row) => row.replica_identity_missing)
    .map((row) => normalizeCatalogTable(row.qualified_name))
}

function integerSetting(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function normalizeCatalogTable(value: string): string {
  return value.replaceAll('"', '').toLowerCase()
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
