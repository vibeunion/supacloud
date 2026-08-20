import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildPowerSyncPostgresArgs,
  liteCapabilities,
  validatePowerSyncReplicationOptions,
  writePowerSyncHba,
  type PowerSyncReplicationOptions,
} from '../src/index.js'

const baseOptions: PowerSyncReplicationOptions = {
  profile: 'powersync',
  host: '127.0.0.1',
  port: 54322,
  allowCidrs: ['127.0.0.1/32'],
  publicationTables: ['public.lab_entries'],
  password: 'x'.repeat(48),
}

describe('PowerSync native replication profile', () => {
  test('keeps PGlite explicitly unsupported and native opt-in', () => {
    expect(liteCapabilities('pglite')).toEqual({
      engine: 'pglite',
      state_machine_sql: 'supported',
      durable_workflows: 'supported',
      commands: 'supported',
      artifacts: 'supported',
      postgrest_schema_config: 'static',
      logical_replication: 'unsupported',
      powersync_source: 'unsupported',
    })
    expect(liteCapabilities('native')).toMatchObject({
      logical_replication: 'disabled',
      powersync_source: 'disabled',
    })
    expect(liteCapabilities('native', 'powersync')).toMatchObject({
      logical_replication: 'supported',
      powersync_source: 'supported',
      replication_profile: 'powersync',
    })
  })

  test('requires an allowlist, strong password, and TLS outside loopback', () => {
    expect(() => validatePowerSyncReplicationOptions({
      ...baseOptions,
      publicationTables: [],
    })).toThrow('explicit publication table allowlist')
    expect(() => validatePowerSyncReplicationOptions({
      ...baseOptions,
      password: 'short',
    })).toThrow('at least 32 characters')
    expect(() => validatePowerSyncReplicationOptions({
      ...baseOptions,
      host: '0.0.0.0',
      allowCidrs: ['10.20.0.0/16'],
    })).toThrow('requires TLS')
  })

  test('writes a deny-by-default HBA and bounded WAL settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supacloud-lite-replication-profile-'))
    const hbaFile = join(root, 'pg_hba.conf')
    try {
      writePowerSyncHba(hbaFile, baseOptions)
      const hba = await readFile(hbaFile, 'utf8')
      expect(hba).toContain('host postgres supacloud_powersync 127.0.0.1/32 scram-sha-256')
      expect(hba).toContain('host replication supacloud_powersync 127.0.0.1/32 scram-sha-256')
      expect(hba).toContain('host all all 0.0.0.0/0 reject')

      const args = buildPowerSyncPostgresArgs(baseOptions, hbaFile)
      expect(args).toContain('wal_level=logical')
      expect(args).toContain('max_wal_senders=4')
      expect(args).toContain('max_replication_slots=4')
      expect(args).toContain('max_slot_wal_keep_size=1024MB')
      expect(args).toContain('ssl=off')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('accepts non-loopback listeners only with protected TLS material and CIDRs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supacloud-lite-replication-tls-'))
    const certFile = join(root, 'server.crt')
    const keyFile = join(root, 'server.key')
    try {
      await writeFile(certFile, 'certificate')
      await writeFile(keyFile, 'private-key')
      await chmod(keyFile, 0o600)
      const validated = validatePowerSyncReplicationOptions({
        ...baseOptions,
        host: '0.0.0.0',
        allowCidrs: ['10.20.0.0/16'],
        tls: { certFile, keyFile },
      })
      expect(validated.tls).toEqual({ certFile, keyFile })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
