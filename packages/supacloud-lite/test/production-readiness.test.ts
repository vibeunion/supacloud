import { describe, expect, test } from 'bun:test'
import { productionReadiness, type ProductionReadinessInput } from '../src/runtime/node/production-readiness.js'

function input(overrides: Partial<ProductionReadinessInput> = {}): ProductionReadinessInput {
  return {
    engine: 'native',
    runtimeMode: 'strict',
    storageBackend: 's3',
    identityMode: 'external',
    host: '127.0.0.1',
    projectDir: '/srv/app',
    stateDir: '/var/lib/app',
    storageDir: '/var/lib/app/storage',
    dataDir: '/var/lib/app/pgdata',
    apiUrl: 'https://app.example.com',
    siteUrl: 'https://app.example.com',
    externalAuthProxyIssuer: 'https://auth.example.com/auth/v1',
    latestSnapshotAt: 1_700_000_000_000,
    now: 1_700_000_000_000,
    ...overrides,
  }
}

describe('production readiness', () => {
  test('accepts a strict, durable, proxied single-node deployment', () => {
    const report = productionReadiness(input())
    expect(report.ready).toBe(true)
    expect(report.blockers).toEqual([])
    expect(report.warnings).toEqual(['S3_OBJECTS_NOT_INCLUDED_IN_SNAPSHOT: back up the bucket/prefix separately'])
  })

  test('blocks development runtime and non-durable memory storage', () => {
    const report = productionReadiness(input({ runtimeMode: 'development', storageBackend: 'memory' }))
    expect(report.ready).toBe(false)
    expect(report.blockers).toContain('RUNTIME_MODE_NOT_STRICT: production functions require strict runtime mode')
    expect(report.blockers).toContain('MEMORY_STORAGE_NOT_DURABLE: memory storage loses objects on restart')
  })

  test('warns for direct public binds, local files, local auth and cross-origin identity', () => {
    const report = productionReadiness(input({
      host: '0.0.0.0',
      storageBackend: 'fs',
      identityMode: 'local',
      externalAuthProxyIssuer: undefined,
      engine: 'pglite',
    }))
    expect(report.warnings).toContain('DIRECT_NETWORK_BIND_WITHOUT_LITE_TLS: terminate TLS in a trusted proxy or restrict the network boundary')
    expect(report.warnings).toContain('LOCAL_STORAGE_REQUIRES_DURABLE_VOLUME_AND_BACKUP')
    expect(report.warnings).toContain('LOCAL_AUTH_IN_PRODUCTION: own account lifecycle, confirmation and password reset')
    expect(report.warnings).toContain('PGLITE_SINGLE_PROCESS_CAPACITY: validate the real schema, concurrency and Realtime load')
    expect(report.warnings).not.toContain('EXTERNAL_AUTH_PROXY_NOT_CONFIGURED: cross-origin browser token/userinfo calls may fail CORS')
  })

  test('warns when external identity has no same-origin proxy', () => {
    const report = productionReadiness(input({ externalAuthProxyIssuer: undefined }))
    expect(report.warnings).toContain('EXTERNAL_AUTH_PROXY_NOT_CONFIGURED: cross-origin browser token/userinfo calls may fail CORS')
  })

  test('blocks overlapping database and storage paths and invalid proxy issuers', () => {
    const report = productionReadiness(input({
      dataDir: '/var/lib/app/storage',
      externalAuthProxyIssuer: 'http://auth.example.com/auth/v1',
    }))
    expect(report.ready).toBe(false)
    expect(report.blockers).toContain('DATABASE_AND_STORAGE_PATH_OVERLAP: use separate directories')
    expect(report.blockers).toContain('EXTERNAL_AUTH_PROXY_ISSUER_INVALID: use an HTTPS issuer, or HTTP only on loopback')
  })

  test('warns when mutable state lives in the project checkout or snapshots are missing/stale', () => {
    const missing = productionReadiness(input({
      stateDir: '/srv/app/.supacloud-lite',
      latestSnapshotAt: undefined,
    }))
    expect(missing.warnings).toContain('STATE_INSIDE_PROJECT: keep mutable state outside the reviewed project checkout')
    expect(missing.warnings).toContain('NO_SNAPSHOT_FOUND: create and test a restore snapshot before promotion')

    const stale = productionReadiness(input({
      latestSnapshotAt: 1_600_000_000_000,
      now: 1_700_000_000_000,
    }))
    expect(stale.warnings).toContain('SNAPSHOT_STALE: newest snapshot is older than 7 days')
  })
})
