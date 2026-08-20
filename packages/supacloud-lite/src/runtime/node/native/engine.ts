/**
 * Native embedded Postgres engine - PocketBase-class footprint with real
 * Postgres semantics. Downloads platform binaries once (~12 MB from
 * theseus-rs/postgresql-binaries), runs initdb with memory-lean settings,
 * and manages the postgres child process. Trust auth over a private unix
 * socket directory (0700), never TCP.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { extract as extractTar } from 'tar'
import { acquireDataDirLock } from '../../db/data-dir-lock.js'
import type { DbEngine } from '../../db/engine.js'
import {
  buildPowerSyncPostgresArgs,
  writePowerSyncHba,
  type NativeReplicationOptions,
} from './replication.js'
import { PgWireClient } from './wire.js'
import { buildWireEngine } from './wire-engine.js'

const DEFAULT_PG_VERSION = '17.7.0'
const POSTGRES_MIRROR_URL_ERROR =
  'SUPACLOUD_LITE_POSTGRES_MIRROR must be an absolute HTTPS URL or a loopback HTTP URL'
export const NATIVE_POSTGRES_MAJOR = DEFAULT_PG_VERSION.split('.')[0]!

const GLIBC_DYNAMIC_LOADERS = {
  x64: [
    '/lib64/ld-linux-x86-64.so.2',
    '/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
  ],
  arm64: [
    '/lib/ld-linux-aarch64.so.1',
    '/lib64/ld-linux-aarch64.so.1',
    '/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1',
  ],
} as const

export interface GlibcRuntimeEvidence {
  runtimeVersion?: string
  dynamicLoaderPresent: boolean
  lddVersion?: string
}

/** Options for {@link createNativeEngine}. */
export interface NativeEngineOptions {
  /** Postgres data directory (created + initdb'd if missing). */
  dataDir: string
  /** Postgres version tag from theseus-rs/postgresql-binaries. */
  version?: string
  /** Where downloaded binaries are cached. Default ~/.cache/supacloud-lite */
  cacheDir?: string
  /** sink for progress lines (download, install); no-op when omitted */
  log?: (msg: string) => void
  /** Optional HTTPS or loopback HTTP prefix for proxying the PostgreSQL release download. */
  downloadMirror?: string
  /** Optional externally reachable logical-replication profile. Disabled by default. */
  replication?: NativeReplicationOptions
}

export function isNativeEngineSupported(): boolean {
  return (process.platform === 'darwin' || process.platform === 'linux') &&
    (process.arch === 'arm64' || process.arch === 'x64') &&
    (process.platform !== 'linux' || isGlibcLinux())
}

function isGlibcLinux(): boolean {
  const runtimeEvidence: GlibcRuntimeEvidence = {
    runtimeVersion: reportedGlibcVersion(),
    dynamicLoaderPresent: glibcDynamicLoaderPresent(),
  }
  return isGlibcRuntime(runtimeEvidence) || isGlibcRuntime({ ...runtimeEvidence, lddVersion: lddVersion() })
}

export function isGlibcRuntime(evidence: GlibcRuntimeEvidence): boolean {
  return Boolean(evidence.runtimeVersion?.trim()) ||
    evidence.dynamicLoaderPresent ||
    /glibc|gnu libc/i.test(evidence.lddVersion ?? '')
}

function reportedGlibcVersion(): string | undefined {
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: unknown } } | undefined
  const runtimeVersion = report?.header?.glibcVersionRuntime
  return typeof runtimeVersion === 'string' ? runtimeVersion : undefined
}

function glibcDynamicLoaderPresent(): boolean {
  const loaderPaths = process.arch === 'x64'
    ? GLIBC_DYNAMIC_LOADERS.x64
    : process.arch === 'arm64' ? GLIBC_DYNAMIC_LOADERS.arm64 : []
  return loaderPaths.some((loaderPath) => existsSync(loaderPath))
}

function lddVersion(): string | undefined {
  const command = spawnSync('ldd', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (command.error || command.status !== 0) return undefined
  return `${command.stdout}\n${command.stderr}`.trim()
}

function target(): string {
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : null
  if (!arch) throw new Error(`unsupported architecture for native engine: ${process.arch}`)
  if (process.platform === 'darwin') return `${arch}-apple-darwin`
  if (process.platform === 'linux') return `${arch}-unknown-linux-gnu`
  throw new Error(`unsupported platform for native engine: ${process.platform} (use the default PGlite engine)`)
}

/** A binary install is only usable if both the server and its catalog seed are present. */
function isCompleteInstall(dir: string): boolean {
  return existsSync(join(dir, 'bin', 'postgres')) && existsSync(join(dir, 'share', 'postgres.bki'))
}

/**
 * Pinned SHA-256 digests for the tarballs we download, keyed by
 * `postgresql-<version>-<target>`. A pinned entry is enforced offline (strongest
 * integrity). For versions/targets not listed here we fall back to the checksum
 * the release publishes alongside the tarball, which still defends against
 * truncated downloads and mismatched redirects.
 */
const PINNED_SHA256: Record<string, string> = {
  // theseus-rs/postgresql-binaries 17.7.0 (the DEFAULT_PG_VERSION). Refresh
  // these from the release *.sha256 files whenever DEFAULT_PG_VERSION changes.
  'postgresql-17.7.0-x86_64-unknown-linux-gnu': '66ad03281a43624f955c8e16ac975cb0ab751e7edf8ba35308e3b08dd7d065c3',
  'postgresql-17.7.0-aarch64-unknown-linux-gnu': '89cc2f089880cc8e5e6b7a29387829ec4e4779427855bc0b9fa187c8fce33c8b',
  'postgresql-17.7.0-x86_64-apple-darwin': '0dd8c25173524bad4ae8ef6b970da1ac40f4c1f231150c416ccb8cd06feff8f2',
  'postgresql-17.7.0-aarch64-apple-darwin': '727ac08d20a704014a0d51eb3300aa0c8e292c1cf0a1c99d4f4b1002e1420220',
}

/** Verify `tarball` against a pinned digest, else the release's published .sha256. */
async function verifyTarball(tarball: string, key: string, upstreamUrl: string, downloadMirror?: string): Promise<void> {
  const actual = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  const pinned = PINNED_SHA256[key]
  if (pinned) {
    if (actual !== pinned) {
      throw new Error(`postgres binary checksum mismatch for ${key}: expected ${pinned}, got ${actual}`)
    }
    return
  }
  // No local pin - verify against the checksum the release publishes.
  const checksumUrl = resolvePostgresDownloadUrl(`${upstreamUrl}.sha256`, downloadMirror)
  const res = await fetchRelease(checksumUrl)
  if (!res.ok) throw new Error(`could not fetch checksum for ${key}: HTTP ${res.status}`)
  const expected = (await res.text()).trim().split(/\s+/)[0].toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error(`malformed published checksum for ${key}`)
  if (actual !== expected) {
    throw new Error(`postgres binary checksum mismatch for ${key}: expected ${expected}, got ${actual}`)
  }
}

/** Download + unpack Postgres binaries if not already cached (concurrency-safe). Returns the install dir. */
export async function ensurePostgres(
  version = DEFAULT_PG_VERSION,
  cacheDir?: string,
  log?: (m: string) => void,
  downloadMirror?: string,
): Promise<string> {
  const t = target()
  const root = cacheDir ?? join(homedir(), '.cache', 'supacloud-lite')
  const dir = join(root, `postgresql-${version}-${t}`)
  if (isCompleteInstall(dir)) return dir

  // Concurrency-safe: multiple test workers / processes may call this at once on
  // a cold cache. Each downloads + extracts to unique temp paths, then atomically
  // renames into place - so no worker ever sees a half-written tarball or a
  // partially-extracted install dir.
  const upstreamUrl = `https://github.com/theseus-rs/postgresql-binaries/releases/download/${version}/postgresql-${version}-${t}.tar.gz`
  const url = resolvePostgresDownloadUrl(upstreamUrl, downloadMirror)
  mkdirSync(root, { recursive: true })
  const uniq = `${process.pid}-${randomBytes(6).toString('hex')}`
  const tarball = join(root, `pg-${version}-${uniq}.tar.gz`)
  const tmpDir = join(root, `.tmp-${version}-${t}-${uniq}`)

  try {
    if (isCompleteInstall(dir)) return dir // another worker finished while we started
    log?.(`downloading postgres ${version} (${t})…`)
    const res = await fetchRelease(url)
    if (!res.ok) throw new Error(`failed to download ${url}: HTTP ${res.status}`)
    await writeFile(tarball, Buffer.from(await res.arrayBuffer()))
    // Integrity-check the tarball before executing anything it contains.
    await verifyTarball(tarball, `postgresql-${version}-${t}`, upstreamUrl, downloadMirror)
    mkdirSync(tmpDir, { recursive: true })
    await extractTar({ cwd: tmpDir, file: tarball, gzip: true, preserveOwner: false, strict: true, strip: 1 })
    if (!isCompleteInstall(tmpDir)) throw new Error('postgres archive extracted incompletely')

    // publish atomically; if another worker already did (or a stale dir exists), reconcile
    try {
      renameSync(tmpDir, dir)
    } catch {
      if (!isCompleteInstall(dir)) {
        rmSync(dir, { recursive: true, force: true })
        renameSync(tmpDir, dir)
      }
    }
    log?.(`postgres installed to ${dir}`)
    return dir
  } finally {
    rmSync(tarball, { force: true })
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

/**
 * Prefix a trusted GitHub release URL with an operator-selected mirror. The
 * archive is still checked against the pinned or published SHA-256 before use.
 */
export function resolvePostgresDownloadUrl(upstreamUrl: string, downloadMirror?: string): string {
  const mirror = postgresDownloadMirror(downloadMirror)
  return mirror ? `${mirror.toString().replace(/\/+$/, '')}/${upstreamUrl}` : upstreamUrl
}

function postgresDownloadMirror(downloadMirror?: string): URL | undefined {
  const configuredMirror = downloadMirror ?? process.env.SUPACLOUD_LITE_POSTGRES_MIRROR
  const mirrorText = configuredMirror?.trim()
  if (!mirrorText) return undefined
  let mirror: URL
  try {
    mirror = new URL(mirrorText)
  } catch {
    throw new Error(POSTGRES_MIRROR_URL_ERROR)
  }
  const loopbackHttp = mirror.protocol === 'http:' &&
    (mirror.hostname === '127.0.0.1' || mirror.hostname === 'localhost' || mirror.hostname === '[::1]')
  if (mirror.protocol !== 'https:' && !loopbackHttp) throw new Error(POSTGRES_MIRROR_URL_ERROR)
  if (mirror.username || mirror.password) {
    throw new Error('SUPACLOUD_LITE_POSTGRES_MIRROR must not contain credentials')
  }
  if (mirrorText.includes('?') || mirrorText.includes('#')) {
    throw new Error('SUPACLOUD_LITE_POSTGRES_MIRROR must not contain a query or fragment')
  }
  return mirror
}

async function fetchRelease(url: string): Promise<Response> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url)
      if (response.ok || response.status < 500) return response
      lastError = new Error(`failed to download ${url}: HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500))
  }
  throw lastError instanceof Error ? lastError : new Error(`failed to download ${url}`)
}

const TUNED_CONF = `
# supacloud-lite: memory-lean settings for an embedded, single-app Postgres
listen_addresses = ''
shared_buffers = 16MB
dynamic_shared_memory_type = posix
max_connections = 10
wal_level = minimal
max_wal_senders = 0
max_replication_slots = 0
logging_collector = off
`

/**
 * Boot the embedded Postgres child (initdb on first run) and return a {@link DbEngine}
 * backed by two wire connections: one for queries/transactions (serialized by a mutex),
 * one dedicated to LISTEN/NOTIFY.
 */
export async function createNativeEngine(opts: NativeEngineOptions): Promise<DbEngine> {
  const releaseLock = await acquireDataDirLock(opts.dataDir, 'native PostgreSQL')
  let socketDirectory: string | undefined
  let postgres: ChildProcess | undefined
  let removeExitHandler: (() => void) | undefined
  try {
    const installDir = await ensurePostgres(opts.version, opts.cacheDir, opts.log, opts.downloadMirror)
    const bin = (name: string) => join(installDir, 'bin', name)

    if (!existsSync(join(opts.dataDir, 'PG_VERSION'))) {
      mkdirSync(opts.dataDir, { recursive: true })
      try {
        execFileSync(bin('initdb'), ['-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '-D', opts.dataDir], {
          stdio: 'pipe',
        })
      } catch (error) {
        const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? ''
        throw new Error(`initdb failed:\n${stderr || (error as Error).message}`)
      }
      appendFileSync(join(opts.dataDir, 'postgresql.conf'), TUNED_CONF)
    }

    removeStalePidFile(join(opts.dataDir, 'postmaster.pid'))

    socketDirectory = mkdtempSync(join(tmpdir(), 'scl-'))
    chmodSync(socketDirectory, 0o700)

    const replicationHba = opts.replication ? join(opts.dataDir, 'supacloud-powersync-hba.conf') : undefined
    if (opts.replication && replicationHba) writePowerSyncHba(replicationHba, opts.replication)
    const replicationArgs = opts.replication && replicationHba
      ? buildPowerSyncPostgresArgs(opts.replication, replicationHba)
      : [
          '-c', 'listen_addresses=',
          '-c', 'wal_level=minimal',
          '-c', 'max_wal_senders=0',
          '-c', 'max_replication_slots=0',
        ]
    postgres = spawn(
      bin('postgres'),
      ['-D', opts.dataDir, '-k', socketDirectory, '-c', 'timezone=UTC', ...replicationArgs],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: false,
      }
    )
    let postgresExited = false
    let postgresStderr = ''
    postgres.stderr?.on('data', (chunk: Buffer) => {
      postgresStderr = (postgresStderr + chunk.toString()).slice(-4000)
    })
    postgres.on('exit', () => (postgresExited = true))

    const killPostgres = (): void => {
      if (!postgresExited) postgres?.kill('SIGTERM')
    }
    process.once('exit', killPostgres)
    removeExitHandler = () => process.off('exit', killPostgres)

    const postgresPort = opts.replication?.port ?? 5432
    const socketPath = join(socketDirectory, `.s.PGSQL.${postgresPort}`)
    const connect = async (): Promise<PgWireClient> => {
      const deadline = Date.now() + 20_000
      while (Date.now() <= deadline) {
        try {
          return await PgWireClient.connect({ socketPath, user: 'postgres', database: 'postgres' })
        } catch (error) {
          if (postgresExited) {
            const detail = postgresStderr.trim()
            throw new Error(
              `embedded postgres failed to start${detail ? `:\n${detail}` : ' (no output)'}\n\n` +
                `data dir: ${opts.dataDir}\n` +
                'If a previous run is still holding it, stop it; or delete the data dir to start fresh.'
            )
          }
          await new Promise((resolve) => setTimeout(resolve, 150))
        }
      }
      throw new Error(`timed out waiting for embedded postgres at ${socketPath}`)
    }

    return await buildWireEngine({
      connect,
      onClose: async () => {
        removeExitHandler?.()
        await stopPostgres(postgres!, () => postgresExited)
        rmSync(socketDirectory!, { recursive: true, force: true })
        await releaseLock()
      },
    })
  } catch (error) {
    removeExitHandler?.()
    if (postgres) await stopPostgres(postgres, () => postgres!.exitCode !== null)
    if (socketDirectory) rmSync(socketDirectory, { recursive: true, force: true })
    await releaseLock()
    throw error
  }
}

async function stopPostgres(postgres: ChildProcess, hasExited: () => boolean): Promise<void> {
  if (hasExited()) return
  postgres.kill('SIGINT')
  await new Promise<void>((resolve) => {
    const killTimeout = setTimeout(() => {
      postgres.kill('SIGKILL')
      resolve()
    }, 5000)
    postgres.once('exit', () => {
      clearTimeout(killTimeout)
      resolve()
    })
  })
}

function removeStalePidFile(pidPath: string): void {
  if (!existsSync(pidPath)) return
  try {
    const pid = Number.parseInt(readFileSync(pidPath, 'utf8').split('\n')[0]?.trim() ?? '', 10)
    if (!pid) {
      rmSync(pidPath, { force: true })
      return
    }
    try {
      process.kill(pid, 0)
    } catch {
      rmSync(pidPath, { force: true })
    }
  } catch {
    // PostgreSQL reports a precise diagnostic for an unreadable pid file.
  }
}
