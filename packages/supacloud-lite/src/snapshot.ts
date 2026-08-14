import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'
import { create as createTar, extract as extractTar } from 'tar'
import type { ConfiguredStorageBackend, DatabaseEngine, ProjectPaths } from './project-runtime.js'
import { recoverStaleDataDirLock } from './runtime/db/data-dir-lock.js'
import { NATIVE_POSTGRES_MAJOR } from './runtime/node/native/engine.js'

const SNAPSHOT_FORMAT = 'supacloud-lite-snapshot'
const SNAPSHOT_VERSION = 1

export interface SnapshotManifest {
  format: typeof SNAPSHOT_FORMAT
  version: typeof SNAPSHOT_VERSION
  createdAt: string
  packageVersion: string
  storageBackend: ConfiguredStorageBackend
  includesDatabase: boolean
  includesLocalStorage: boolean
  includesSecrets: true
  databaseEngine?: DatabaseEngine
  platform?: string
  architecture?: string
  postgresMajor?: string
}

export interface CreateSnapshotOptions {
  paths: ProjectPaths
  packageVersion: string
  storageBackend: ConfiguredStorageBackend
  output: string
}

export interface RestoreSnapshotOptions {
  paths: ProjectPaths
  storageBackend: ConfiguredStorageBackend
  input: string
  force?: boolean
}

export interface RestoreSnapshotResult {
  manifest: SnapshotManifest
  rollbackPaths: string[]
}

/**
 * Create a portable, compressed snapshot of the durable Lite state.
 * The caller must stop Lite first; the data-directory lock is checked here.
 */
export async function createSnapshot(options: CreateSnapshotOptions): Promise<SnapshotManifest> {
  const paths = normalizePaths(options.paths)
  await assertSnapshotPaths(paths)
  await assertNoDataDirectoryLock(paths)

  const manifest: SnapshotManifest = {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    createdAt: new Date().toISOString(),
    packageVersion: options.packageVersion,
    storageBackend: options.storageBackend,
    includesDatabase: Boolean(paths.dataDir),
    includesLocalStorage: options.storageBackend === 'fs',
    includesSecrets: true,
    databaseEngine: paths.databaseEngine,
    ...(paths.databaseEngine === 'native'
      ? {
          platform: process.platform,
          architecture: process.arch,
          postgresMajor: await readPostgresMajor(paths.dataDir),
        }
      : {}),
  }

  const output = resolve(options.output)
  if (await existingInfo(output)) throw new Error(`snapshot output already exists: ${output}`)
  await mkdir(dirname(output), { recursive: true })
  const stagingRoot = await mkdtemp(join(dirname(output), '.supacloud-lite-snapshot-'))
  try {
    await writeFile(join(stagingRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await stageFile(paths.secretsFile, join(stagingRoot, 'secrets.json'))
    if (paths.dataDir) await stageDirectory(paths.dataDir, join(stagingRoot, 'database'))
    if (options.storageBackend === 'fs') await stageDirectory(paths.storageDir, join(stagingRoot, 'storage'))
    const entries = ['manifest.json', 'secrets.json']
    if (paths.dataDir) entries.push('database')
    if (options.storageBackend === 'fs') entries.push('storage')
    await createTar({ cwd: stagingRoot, file: output, gzip: true, portable: true }, entries)
    if (process.platform !== 'win32') await chmod(output, 0o600)
    return manifest
  } catch (error) {
    await rm(output, { force: true })
    throw error
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

/**
 * Restore a snapshot without touching an existing non-empty target unless
 * `force` is explicitly set. Existing targets are renamed aside for rollback.
 */
export async function restoreSnapshot(options: RestoreSnapshotOptions): Promise<RestoreSnapshotResult> {
  const paths = normalizePaths(options.paths)
  await assertSnapshotPaths(paths, { requireSecrets: false, allowMissingState: true })
  await assertNoDataDirectoryLock(paths)

  const stagingRoot = await mkdtemp(join(dirname(paths.stateDir), '.supacloud-lite-restore-'))
  const payloadRoot = join(stagingRoot, 'payload')
  const rollbackId = crypto.randomUUID()
  const rollbackPaths: string[] = []

  try {
    await mkdir(payloadRoot, { recursive: true })
    await extractTar({
      cwd: payloadRoot,
      file: resolve(options.input),
      preserveOwner: false,
      preservePaths: false,
      strict: true,
      unlink: true,
      filter: (path, entry) => {
        const normalized = path.replaceAll('\\', '/')
        const allowedPath = normalized === 'manifest.json' || normalized === 'secrets.json' ||
          normalized === 'database' || normalized.startsWith('database/') ||
          normalized === 'storage' || normalized.startsWith('storage/')
        if (!allowedPath || normalized.startsWith('/') || normalized.split('/').includes('..')) {
          throw new Error(`snapshot contains an unsafe path: ${path}`)
        }
        const entryType = 'type' in entry ? entry.type : undefined
        if (entryType !== 'File' && entryType !== 'Directory') {
          throw new Error(`snapshot contains an unsupported entry type: ${entryType ?? 'unknown'}`)
        }
        return true
      },
    })
    await assertNoSymlinks(payloadRoot)
    const manifest = await readManifest(payloadRoot)
    if (manifest.storageBackend !== options.storageBackend) {
      throw new Error(
        `snapshot storage backend is ${manifest.storageBackend}, but the target uses ${options.storageBackend}; ` +
        'restore with the matching --storage-backend value'
      )
    }
    assertDatabaseSnapshotCompatible(manifest, paths)
    if (manifest.includesDatabase !== Boolean(paths.dataDir)) {
      throw new Error('snapshot database mode does not match the target; do not restore a persistent snapshot into --memory')
    }
    if (manifest.includesLocalStorage !== (options.storageBackend === 'fs')) {
      throw new Error('snapshot storage payload does not match the target storage backend')
    }
    await assertSnapshotPayload(payloadRoot, manifest)
    if (manifest.includesDatabase) await mkdir(join(payloadRoot, 'database'), { recursive: true })
    if (manifest.includesLocalStorage) await mkdir(join(payloadRoot, 'storage'), { recursive: true })
    await assertRestoreTargets(paths, manifest, options.force === true)

    const stateStage = join(stagingRoot, 'state')
    await mkdir(stateStage, { recursive: true })
    await copyEntry(join(payloadRoot, 'secrets.json'), join(stateStage, 'secrets.json'))
    if (paths.dataDir && isWithin(paths.stateDir, paths.dataDir)) {
      await copyEntry(join(payloadRoot, 'database'), join(stateStage, relative(paths.stateDir, paths.dataDir)))
    }
    if (options.storageBackend === 'fs' && isWithin(paths.stateDir, paths.storageDir)) {
      await copyEntry(join(payloadRoot, 'storage'), join(stateStage, relative(paths.stateDir, paths.storageDir)))
    }

    const swaps: DirectorySwap[] = []
    try {
      await applyDirectorySwap(stateStage, paths.stateDir, options.force === true, rollbackId, swaps)
      if (paths.dataDir && !isWithin(paths.stateDir, paths.dataDir)) {
        await applyDirectorySwap(join(payloadRoot, 'database'), paths.dataDir, options.force === true, rollbackId, swaps)
      }
      if (options.storageBackend === 'fs' && !isWithin(paths.stateDir, paths.storageDir)) {
        await applyDirectorySwap(join(payloadRoot, 'storage'), paths.storageDir, options.force === true, rollbackId, swaps)
      }
    } catch (error) {
      await rollbackDirectorySwaps(swaps)
      throw error
    }
    rollbackPaths.push(...swaps.flatMap((swap) => swap.rollbackPath ? [swap.rollbackPath] : []))
    if (process.platform !== 'win32') {
      await hardenRestoredTree(paths.stateDir)
      if (paths.dataDir && !isWithin(paths.stateDir, paths.dataDir)) await hardenRestoredTree(paths.dataDir)
      if (options.storageBackend === 'fs' && !isWithin(paths.stateDir, paths.storageDir)) {
        await hardenRestoredTree(paths.storageDir)
      }
    }
    return { manifest, rollbackPaths }
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

function normalizePaths(paths: ProjectPaths): ProjectPaths {
  return {
    ...paths,
    projectDir: resolve(paths.projectDir),
    stateDir: resolve(paths.stateDir),
    dataDir: paths.dataDir ? resolve(paths.dataDir) : undefined,
    storageDir: resolve(paths.storageDir),
    secretsFile: resolve(paths.secretsFile),
  }
}

async function assertSnapshotPaths(
  paths: ProjectPaths,
  options: { requireSecrets?: boolean; allowMissingState?: boolean } = {},
): Promise<void> {
  try {
    if (paths.stateDir === parse(paths.stateDir).root) throw new Error('snapshot state directory must not be the filesystem root')
    if (paths.secretsFile !== join(paths.stateDir, 'secrets.json')) throw new Error('snapshot secrets path must be inside the state directory')
    const stateInfo = await lstat(paths.stateDir)
    if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink()) throw new Error(`state directory must be a real directory: ${paths.stateDir}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || options.allowMissingState !== true) throw error
  }
  if (paths.dataDir && paths.storageDir && pathsOverlap(paths.dataDir, paths.storageDir)) {
    throw new Error('database and storage directories must not overlap')
  }
  await assertDirectoryOrMissing(paths.dataDir)
  await assertDirectoryOrMissing(paths.storageDir)
  if (options.requireSecrets !== false) {
    const secretInfo = await lstat(paths.secretsFile)
    if (!secretInfo.isFile() || secretInfo.isSymbolicLink()) throw new Error(`secrets file must be a regular file: ${paths.secretsFile}`)
  }
}

async function assertDirectoryOrMissing(path: string | undefined): Promise<void> {
  if (!path) return
  if (resolve(path) === parse(resolve(path)).root) throw new Error(`snapshot path must not be the filesystem root: ${path}`)
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`snapshot path must be a real directory: ${path}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function assertNoDataDirectoryLock(paths: ProjectPaths): Promise<void> {
  if (!paths.dataDir) return
  const lockPath = `${paths.dataDir}.supacloud-lite.lock`
  const lockState = await recoverStaleDataDirLock(lockPath)
  if (lockState.kind === 'missing') return
  if (lockState.kind === 'active') throw new Error(`data directory is already in use: ${paths.dataDir} (pid ${lockState.owner.pid})`)
  throw new Error(`data directory has an unreadable lock: ${lockPath}; confirm Lite is stopped, then remove the lock manually`)
}

async function stageDirectory(root: string, destination: string): Promise<void> {
  try {
    const info = await lstat(root)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`snapshot path must be a real directory: ${root}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await mkdir(destination, { recursive: true })
      return
    }
    throw error
  }

  await mkdir(destination, { recursive: true })
  const walk = async (current: string, target: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name)
      const targetPath = join(target, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`snapshot refuses symbolic link: ${fullPath}`)
      if (entry.isDirectory()) {
        await mkdir(targetPath, { recursive: true })
        await walk(fullPath, targetPath)
      } else if (entry.isFile()) {
        await stageFile(fullPath, targetPath)
      } else {
        throw new Error(`snapshot refuses unsupported filesystem entry: ${fullPath}`)
      }
    }
  }
  await walk(root, destination)
}

async function stageFile(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
}

async function readManifest(payloadRoot: string): Promise<SnapshotManifest> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(payloadRoot, 'manifest.json'), 'utf8'))
  } catch (error) {
    throw new Error(`invalid snapshot manifest: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isSnapshotManifest(parsed)) throw new Error('unsupported or invalid SupaCloud Lite snapshot manifest')
  return parsed
}

function isSnapshotManifest(value: unknown): value is SnapshotManifest {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<SnapshotManifest>
  return candidate.format === SNAPSHOT_FORMAT && candidate.version === SNAPSHOT_VERSION &&
    typeof candidate.createdAt === 'string' && typeof candidate.packageVersion === 'string' &&
    (candidate.storageBackend === 'fs' || candidate.storageBackend === 's3' || candidate.storageBackend === 'memory') &&
    typeof candidate.includesDatabase === 'boolean' && typeof candidate.includesLocalStorage === 'boolean' && candidate.includesSecrets === true &&
    (candidate.databaseEngine === undefined || candidate.databaseEngine === 'pglite' || candidate.databaseEngine === 'native') &&
    (candidate.platform === undefined || typeof candidate.platform === 'string') &&
    (candidate.architecture === undefined || typeof candidate.architecture === 'string') &&
    (candidate.postgresMajor === undefined || typeof candidate.postgresMajor === 'string')
}

function assertDatabaseSnapshotCompatible(manifest: SnapshotManifest, paths: ProjectPaths): void {
  const sourceEngine = manifest.databaseEngine ?? 'pglite'
  if (sourceEngine !== paths.databaseEngine) {
    throw new Error(`snapshot database engine is ${sourceEngine}, but the target uses ${paths.databaseEngine}`)
  }
  if (sourceEngine !== 'native') return
  if (manifest.platform !== process.platform || manifest.architecture !== process.arch) {
    throw new Error(
      `native PostgreSQL snapshots require the same platform and architecture; ` +
        `source is ${manifest.platform ?? 'unknown'}/${manifest.architecture ?? 'unknown'}, ` +
        `target is ${process.platform}/${process.arch}`
    )
  }
  if (manifest.postgresMajor !== NATIVE_POSTGRES_MAJOR) {
    throw new Error(
      `native PostgreSQL snapshot major is ${manifest.postgresMajor ?? 'unknown'}, ` +
        `but this Lite build uses ${NATIVE_POSTGRES_MAJOR}`
    )
  }
}

async function readPostgresMajor(dataDir?: string): Promise<string | undefined> {
  if (!dataDir) return undefined
  try {
    return (await readFile(join(dataDir, 'PG_VERSION'), 'utf8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function assertSnapshotPayload(payloadRoot: string, manifest: SnapshotManifest): Promise<void> {
  const required = ['manifest.json', 'secrets.json']
  for (const path of required) {
    try {
      await lstat(join(payloadRoot, path))
    } catch {
      throw new Error(`snapshot is missing required payload: ${path}`)
    }
  }
  const allowed = [...required]
  if (manifest.includesDatabase) allowed.push('database')
  if (manifest.includesLocalStorage) allowed.push('storage')
  for (const entry of await readdir(payloadRoot)) {
    if (!allowed.includes(entry)) {
      throw new Error(`snapshot contains an unexpected payload entry: ${entry}`)
    }
  }
}

async function assertRestoreTargets(paths: ProjectPaths, manifest: SnapshotManifest, force: boolean): Promise<void> {
  const targets = [paths.stateDir]
  if (paths.dataDir && !isWithin(paths.stateDir, paths.dataDir)) targets.push(paths.dataDir)
  if (manifest.includesLocalStorage && !isWithin(paths.stateDir, paths.storageDir)) targets.push(paths.storageDir)
  if (!force) {
    for (const target of targets) {
      if (await directoryHasEntries(target)) throw new Error(`restore target is not empty: ${target}; pass --force to replace it`)
    }
  }
}

async function directoryHasEntries(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

interface DirectorySwap {
  target: string
  rollbackPath?: string
}

async function applyDirectorySwap(
  source: string,
  target: string,
  force: boolean,
  rollbackId: string,
  swaps: DirectorySwap[],
): Promise<void> {
  const targetInfo = await existingInfo(target)
  if (targetInfo && !targetInfo.isDirectory()) throw new Error(`restore target is not a directory: ${target}`)
  const swap: DirectorySwap = { target }
  if (targetInfo) {
    if (!force) {
      if (await directoryHasEntries(target)) throw new Error(`restore target is not empty: ${target}; pass --force to replace it`)
      await rm(target, { recursive: true, force: true })
    } else {
      swap.rollbackPath = join(dirname(target), `.${target.split(sep).pop() ?? 'state'}.restore-${rollbackId}`)
      await rename(target, swap.rollbackPath)
    }
  }
  try {
    await mkdir(dirname(target), { recursive: true })
    await rename(source, target)
    swaps.push(swap)
  } catch (error) {
    if (swap.rollbackPath) await rename(swap.rollbackPath, target).catch(() => {})
    throw error
  }
}

async function rollbackDirectorySwaps(swaps: DirectorySwap[]): Promise<void> {
  for (const swap of [...swaps].reverse()) {
    await rm(swap.target, { recursive: true, force: true })
    if (swap.rollbackPath) await rename(swap.rollbackPath, swap.target)
  }
}

async function existingInfo(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function copyEntry(source: string, target: string): Promise<void> {
  const info = await lstat(source)
  if (info.isSymbolicLink()) throw new Error(`snapshot refuses symbolic link: ${source}`)
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true })
    for (const entry of await readdir(source)) await copyEntry(join(source, entry), join(target, entry))
  } else if (info.isFile()) {
    await mkdir(dirname(target), { recursive: true })
    await Bun.write(target, Bun.file(source))
  } else throw new Error(`snapshot refuses unsupported filesystem entry: ${source}`)
}

async function hardenRestoredTree(root: string): Promise<void> {
  const info = await lstat(root)
  if (info.isSymbolicLink()) throw new Error(`snapshot refuses symbolic link: ${root}`)
  if (info.isDirectory()) {
    await chmod(root, 0o700)
    for (const entry of await readdir(root)) await hardenRestoredTree(join(root, entry))
    return
  }
  if (info.isFile()) {
    await chmod(root, 0o600)
    return
  }
  throw new Error(`snapshot refuses unsupported filesystem entry: ${root}`)
}

async function assertNoSymlinks(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`snapshot refuses symbolic link in archive: ${fullPath}`)
    if (entry.isDirectory()) await assertNoSymlinks(fullPath)
  }
}

function isWithin(parent: string, child: string): boolean {
  const normalizedParent = resolve(parent)
  const normalizedChild = resolve(child)
  return normalizedChild !== normalizedParent && normalizedChild.startsWith(`${normalizedParent}${sep}`)
}

function pathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  return normalizedLeft === normalizedRight || isWithin(normalizedLeft, normalizedRight) || isWithin(normalizedRight, normalizedLeft)
}
