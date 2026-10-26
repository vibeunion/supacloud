import { isAbsolute, relative, resolve } from 'node:path'
import type { RuntimeMode } from '../functions/profile.js'

export interface ProductionReadinessInput {
  engine: 'pglite' | 'native'
  runtimeMode: RuntimeMode
  storageBackend: 'fs' | 's3' | 'memory' | 'custom'
  identityMode: 'local' | 'external'
  host: string
  projectDir: string
  stateDir: string
  storageDir: string
  dataDir?: string
  apiUrl?: string
  siteUrl?: string
  externalAuthProxyIssuer?: string
  /** Epoch milliseconds of the newest snapshot, when one exists. */
  latestSnapshotAt?: number
  /** Injectable clock for deterministic tests. */
  now?: number
}

export interface ProductionReadiness {
  ready: boolean
  blockers: string[]
  warnings: string[]
}

const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function within(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function loopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
}

function absoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || (url.protocol === 'http:' && loopback(url.hostname))) && !url.username && !url.password
  } catch {
    return false
  }
}

/**
 * Production readiness is intentionally a policy report, not a deployment
 * primitive. Blockers are settings that are unsafe for every single-node Lite
 * deployment. Warnings are operational obligations the operator must own.
 */
export function productionReadiness(input: ProductionReadinessInput): ProductionReadiness {
  const blockers: string[] = []
  const warnings: string[] = []
  const now = input.now ?? Date.now()

  if (input.runtimeMode !== 'strict') {
    blockers.push('RUNTIME_MODE_NOT_STRICT: production functions require strict runtime mode')
  }
  if (input.storageBackend === 'memory') {
    blockers.push('MEMORY_STORAGE_NOT_DURABLE: memory storage loses objects on restart')
  }
  if (input.storageBackend === 'fs') {
    warnings.push('LOCAL_STORAGE_REQUIRES_DURABLE_VOLUME_AND_BACKUP')
  }
  if (input.storageBackend === 's3') {
    warnings.push('S3_OBJECTS_NOT_INCLUDED_IN_SNAPSHOT: back up the bucket/prefix separately')
  }
  if (!loopback(input.host)) {
    warnings.push('DIRECT_NETWORK_BIND_WITHOUT_LITE_TLS: terminate TLS in a trusted proxy or restrict the network boundary')
  }
  if (input.engine === 'pglite') {
    warnings.push('PGLITE_SINGLE_PROCESS_CAPACITY: validate the real schema, concurrency and Realtime load')
  }
  if (input.identityMode === 'local') {
    warnings.push('LOCAL_AUTH_IN_PRODUCTION: own account lifecycle, confirmation and password reset')
  }
  if (input.identityMode === 'external' && !input.externalAuthProxyIssuer) {
    warnings.push('EXTERNAL_AUTH_PROXY_NOT_CONFIGURED: cross-origin browser token/userinfo calls may fail CORS')
  }
  if (input.externalAuthProxyIssuer && !absoluteHttpUrl(input.externalAuthProxyIssuer)) {
    blockers.push('EXTERNAL_AUTH_PROXY_ISSUER_INVALID: use an HTTPS issuer, or HTTP only on loopback')
  }
  if (!input.siteUrl) {
    warnings.push('SITE_URL_NOT_CONFIGURED: set [auth].site_url for stable redirects')
  } else if (!absoluteHttpUrl(input.siteUrl)) {
    warnings.push('SITE_URL_NOT_HTTPS: production redirects should use HTTPS')
  }
  if (!input.apiUrl) {
    warnings.push('API_URL_NOT_CONFIGURED: set the public API URL used by Auth and Functions')
  } else if (!absoluteHttpUrl(input.apiUrl)) {
    warnings.push('API_URL_NOT_HTTPS: production API URLs should use HTTPS')
  }
  if (within(input.projectDir, input.stateDir)) {
    warnings.push('STATE_INSIDE_PROJECT: keep mutable state outside the reviewed project checkout')
  }
  if (input.dataDir && input.dataDir === input.storageDir) {
    blockers.push('DATABASE_AND_STORAGE_PATH_OVERLAP: use separate directories')
  } else if (input.dataDir && (within(input.dataDir, input.storageDir) || within(input.storageDir, input.dataDir))) {
    warnings.push('DATABASE_AND_STORAGE_PATH_NESTED: keep database and storage trees independent')
  }
  if (input.latestSnapshotAt === undefined) {
    warnings.push('NO_SNAPSHOT_FOUND: create and test a restore snapshot before promotion')
  } else if (now - input.latestSnapshotAt > SNAPSHOT_MAX_AGE_MS) {
    warnings.push('SNAPSHOT_STALE: newest snapshot is older than 7 days')
  }

  return { ready: blockers.length === 0, blockers, warnings }
}
