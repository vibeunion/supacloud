import { chmod, link, lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { createBackend, signJwt, type TinbaseBackend } from './vendor/tinbase/index.js'
import type { WebhookConfig } from './vendor/tinbase/webhooks/service.js'
import { serveBun, type RunningServer } from './vendor/tinbase/node/bun-server.js'
import { FsStorageDriver } from './vendor/tinbase/node/fs-driver.js'
import { loadProjectConfig, type ProjectConfig } from './vendor/tinbase/node/load-config.js'
import { loadFunctionEnv, loadFunctions } from './vendor/tinbase/node/load-functions.js'
import { loadSupabaseProject } from './vendor/tinbase/node/project.js'
import { MemoryStorageDriver } from './vendor/tinbase/storage/driver.js'
import { S3StorageDriver, type S3StorageDriverOptions } from './vendor/tinbase/storage/s3-driver.js'
import type { StorageDriver } from './vendor/tinbase/types.js'

export interface ProjectSecrets {
  jwtSecret: string
  vaultKey: string
  createdAt: string
}

export interface ProjectPaths {
  projectDir: string
  stateDir: string
  dataDir?: string
  storageDir: string
  secretsFile: string
}

export interface ProjectRuntimeOptions {
  projectDir?: string
  stateDir?: string
  dataDir?: string
  storageDir?: string
  storageBackend?: ConfiguredStorageBackend
  storageDriver?: StorageDriver
  s3?: S3StorageDriverOptions
  host?: string
  port?: number
  apiUrl?: string
  siteUrl?: string
  memory?: boolean
  applyMigrations?: boolean
  includeFunctions?: boolean
  includeWebhooks?: boolean
  includeSeed?: boolean
  startRuntimeServices?: boolean
  log?: (message: string) => void
}

export interface ProjectBackend {
  backend: TinbaseBackend
  config: ProjectConfig
  paths: ProjectPaths
  host: string
  port: number
  url: string
  migrationCount: number
  functionNames: string[]
  webhookCount: number
  storageBackend: StorageBackend
}

export type StorageBackend = 'fs' | 'memory' | 's3' | 'custom'
export type ConfiguredStorageBackend = Exclude<StorageBackend, 'custom'>

export interface RunningProjectServer extends ProjectBackend {
  server: RunningServer
  close: () => Promise<void>
}

export function resolveProjectPaths(options: ProjectRuntimeOptions = {}): ProjectPaths {
  const projectDir = resolve(options.projectDir ?? process.cwd())
  const stateDir = resolvePath(projectDir, options.stateDir ?? process.env.SUPACLOUD_LITE_STATE_DIR ?? '.supacloud-lite')
  const dataDir = options.memory
    ? undefined
    : resolvePath(projectDir, options.dataDir ?? process.env.SUPACLOUD_LITE_DATA_DIR ?? join(stateDir, 'db'))
  const storageDir = resolvePath(
    projectDir,
    options.storageDir ?? process.env.SUPACLOUD_LITE_STORAGE_DIR ?? join(stateDir, 'storage')
  )
  return {
    projectDir,
    stateDir,
    dataDir,
    storageDir,
    secretsFile: join(stateDir, 'secrets.json'),
  }
}

export async function assertResetPathsSafe(paths: ProjectPaths): Promise<void> {
  const stateDir = resolve(paths.stateDir)
  if (stateDir === parse(stateDir).root) throw new Error('refusing to use the filesystem root as the state directory')
  const stateInfo = await lstat(stateDir)
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink()) {
    throw new Error(`refusing to reset through an invalid state directory: ${stateDir}`)
  }
  const canonicalStateDir = await realpath(stateDir)
  const secretsFile = resolve(paths.secretsFile)
  if (secretsFile !== join(stateDir, 'secrets.json')) {
    throw new Error(`refusing to reset a state directory with an invalid secrets marker path: ${secretsFile}`)
  }
  const markerInfo = await lstat(secretsFile)
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) {
    throw new Error(`refusing to reset a state directory without a valid secrets marker: ${stateDir}`)
  }
  const targets = [
    ...(paths.dataDir ? [['database', paths.dataDir] as const] : []),
    ['storage', paths.storageDir] as const,
  ]
  for (const [label, targetPath] of targets) {
    const target = resolve(targetPath)
    const relativePath = relative(stateDir, target)
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error(`refusing to reset ${label} path outside the state directory: ${target}`)
    }
    await assertResetTargetCanonical(stateDir, canonicalStateDir, target, label)
  }
}

async function assertResetTargetCanonical(
  stateDir: string,
  canonicalStateDir: string,
  target: string,
  label: string
): Promise<void> {
  let current = target
  while (current !== stateDir) {
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`refusing to reset ${label} path through a symbolic link: ${current}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = dirname(current)
    if (parent === current) throw new Error(`refusing to reset ${label} path outside the state directory: ${target}`)
    current = parent
  }
  const existingAncestor = await nearestExistingAncestor(target)
  const canonicalTarget = resolve(await realpath(existingAncestor), relative(existingAncestor, target))
  const canonicalRelative = relative(canonicalStateDir, canonicalTarget)
  if (!canonicalRelative || canonicalRelative.startsWith('..') || isAbsolute(canonicalRelative)) {
    throw new Error(`refusing to reset ${label} path outside the canonical state directory: ${target}`)
  }
}

async function nearestExistingAncestor(target: string): Promise<string> {
  let current = target
  while (true) {
    try {
      await lstat(current)
      return current
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = dirname(current)
    if (parent === current) throw new Error(`unable to resolve an existing ancestor for ${target}`)
    current = parent
  }
}

export async function ensureProjectSecrets(paths: ProjectPaths): Promise<ProjectSecrets> {
  const envJwt = process.env.SUPACLOUD_LITE_JWT_SECRET
  const envVault = process.env.SUPACLOUD_LITE_VAULT_KEY
  if (envJwt && envVault) return validateSecrets({ jwtSecret: envJwt, vaultKey: envVault, createdAt: 'environment' })

  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 })
  await chmod(paths.stateDir, 0o700)
  let stored: ProjectSecrets
  try {
    stored = validateSecrets(JSON.parse(await readFile(paths.secretsFile, 'utf8')) as Partial<ProjectSecrets>)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const candidate = {
      jwtSecret: randomHex(48),
      vaultKey: randomHex(32),
      createdAt: new Date().toISOString(),
    }
    const temporaryFile = `${paths.secretsFile}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temporaryFile, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      await link(temporaryFile, paths.secretsFile)
      stored = candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      stored = validateSecrets(JSON.parse(await readFile(paths.secretsFile, 'utf8')) as Partial<ProjectSecrets>)
    } finally {
      await unlink(temporaryFile).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
  }
  await chmod(paths.secretsFile, 0o600)
  return validateSecrets({
    ...stored,
    jwtSecret: envJwt ?? stored.jwtSecret,
    vaultKey: envVault ?? stored.vaultKey,
  })
}

export async function mintProjectKeys(jwtSecret: string): Promise<{ anonKey: string; serviceRoleKey: string }> {
  const now = Math.floor(Date.now() / 1000)
  const exp = now + 10 * 365 * 24 * 3600
  const common = { iss: 'supabase', ref: 'local', iat: now, exp }
  return {
    anonKey: await signJwt({ ...common, role: 'anon' }, jwtSecret),
    serviceRoleKey: await signJwt({ ...common, role: 'service_role' }, jwtSecret),
  }
}

export async function createProjectBackend(options: ProjectRuntimeOptions = {}): Promise<ProjectBackend> {
  const paths = resolveProjectPaths(options)
  const host = options.host ?? process.env.SUPACLOUD_LITE_HOST ?? '127.0.0.1'
  const port = options.port ?? parsePort(process.env.SUPACLOUD_LITE_PORT ?? process.env.PORT, 54321)
  const url = options.apiUrl ?? process.env.SUPACLOUD_LITE_API_URL ?? `http://${displayHost(host)}:${port}`
  const config = loadProjectConfig(paths.projectDir)
  const project = await loadSupabaseProject(paths.projectDir, {
    enabled: options.includeSeed === false ? false : config.seed.enabled,
    paths: config.seed.paths,
  })
  const functions = options.includeFunctions === false ? new Map() : await loadFunctions(paths.projectDir, config.functions)
  const functionEnv = options.includeFunctions === false ? {} : await loadFunctionEnv(paths.projectDir)
  const secrets = await ensureProjectSecrets(paths)
  const webhooks = options.includeWebhooks === false ? [] : await loadWebhooks(paths.projectDir)
  const configuredStorageBackend = options.storageDriver ? 'fs' : resolveStorageBackend(options.storageBackend)
  const storageBackend: StorageBackend = options.storageDriver ? 'custom' : configuredStorageBackend

  if (paths.dataDir) {
    await mkdir(paths.dataDir, { recursive: true, mode: 0o700 })
    await chmod(paths.dataDir, 0o700)
  }
  await mkdir(paths.storageDir, { recursive: true, mode: 0o700 })
  await chmod(paths.storageDir, 0o700)

  const backend = await createBackend({
    dataDir: paths.dataDir,
    jwtSecret: secrets.jwtSecret,
    vaultKey: secrets.vaultKey,
    apiUrl: url,
    siteUrl: options.siteUrl ?? process.env.SUPACLOUD_LITE_SITE_URL ?? config.auth.siteUrl ?? url,
    host,
    jwtExpiry: config.auth.jwtExpiry,
    uriAllowList: config.auth.uriAllowList,
    authEnabled: config.auth.enabled,
    authSettings: config.auth.settings,
    authRateLimits: config.auth.rateLimits,
    sessionTimeboxSeconds: config.auth.sessionTimeboxSeconds,
    sessionInactivitySeconds: config.auth.sessionInactivitySeconds,
    oauthProviders: config.auth.oauthProviders,
    dbSchemas: config.api.schemas,
    maxRows: config.api.maxRows,
    storageFileSizeLimit: config.storage.fileSizeLimit,
    buckets: config.storage.buckets,
    migrations: options.applyMigrations === false ? [] : project.migrations,
    seedSql: options.applyMigrations === false || options.includeSeed === false ? undefined : project.seedSql,
    functions,
    functionVerifyJwt: Object.fromEntries(
      Object.entries(config.functions).map(([name, functionOptions]) => [name, functionOptions.verifyJwt !== false])
    ),
    functionEnv,
    webhooks,
    startRuntimeServices: options.startRuntimeServices,
    storageDriver: options.storageDriver ?? createStorageDriver(configuredStorageBackend, paths.storageDir, options.s3),
    log: options.log,
  })

  return {
    backend,
    config,
    paths,
    host,
    port,
    url,
    migrationCount: project.migrations.length,
    functionNames: [...functions.keys()],
    webhookCount: webhooks.length,
    storageBackend,
  }
}

export function resolveStorageBackend(value?: ConfiguredStorageBackend): ConfiguredStorageBackend {
  const configured = value ?? process.env.SUPACLOUD_LITE_STORAGE_BACKEND ?? 'fs'
  if (configured === 'fs' || configured === 'memory' || configured === 's3') return configured
  throw new Error(`unsupported SUPACLOUD_LITE_STORAGE_BACKEND: ${configured}`)
}

function createStorageDriver(
  backend: ConfiguredStorageBackend,
  storageDir: string,
  s3Options?: S3StorageDriverOptions
): StorageDriver {
  if (backend === 'memory') return new MemoryStorageDriver()
  if (backend === 's3') {
    return new S3StorageDriver({
      ...s3Options,
      prefix: s3Options?.prefix ?? process.env.SUPACLOUD_LITE_S3_PREFIX,
    })
  }
  return new FsStorageDriver(storageDir)
}

export async function startProjectServer(options: ProjectRuntimeOptions = {}): Promise<RunningProjectServer> {
  const resolvedOptions = options.port === 0 ? { ...options, port: await findEphemeralPort(options.host) } : options
  const project = await createProjectBackend({ ...resolvedOptions, startRuntimeServices: true })
  try {
    const server = await serveBun(project.backend, { host: project.host, port: project.port })
    let closePromise: Promise<void> | null = null
    return {
      ...project,
      server,
      port: server.port,
      url: server.url,
      close: () => {
        closePromise ??= (async () => {
          let firstError: unknown
          try {
            await server.close()
          } catch (error) {
            firstError = error
          }
          try {
            await project.backend.close()
          } catch (error) {
            firstError ??= error
          }
          if (firstError !== undefined) throw firstError
        })()
        return closePromise
      },
    }
  } catch (error) {
    await project.backend.close()
    throw error
  }
}

async function loadWebhooks(projectDir: string): Promise<WebhookConfig[]> {
  try {
    const parsed = JSON.parse(await readFile(join(projectDir, 'supabase', 'webhooks.json'), 'utf8')) as unknown
    return Array.isArray(parsed) ? (parsed as WebhookConfig[]) : []
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function resolvePath(projectDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(projectDir, path)
}

function randomHex(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes))
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function validateSecrets(value: Partial<ProjectSecrets>): ProjectSecrets {
  if (typeof value.jwtSecret !== 'string' || value.jwtSecret.length < 32) {
    throw new Error('SupaCloud Lite JWT secret must contain at least 32 characters')
  }
  if (typeof value.vaultKey !== 'string' || value.vaultKey.length < 32) {
    throw new Error('SupaCloud Lite vault key must contain at least 32 characters')
  }
  return {
    jwtSecret: value.jwtSecret,
    vaultKey: value.vaultKey,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
  }
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const port = Number.parseInt(value, 10)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port: ${value}`)
  return port
}

function displayHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1'
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

async function findEphemeralPort(host = '127.0.0.1'): Promise<number> {
  const server = Bun.serve({ hostname: host, port: 0, fetch: () => new Response(null, { status: 204 }) })
  const port = server.port
  await server.stop(true)
  if (port === undefined) throw new Error('Bun did not allocate an ephemeral port')
  return port
}
