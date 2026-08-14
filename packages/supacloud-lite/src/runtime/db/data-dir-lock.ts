import { mkdir, open, readFile, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export interface DataDirLockOwner {
  pid: number
  nonce: string
}

export type DataDirLockState =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'active'; owner: DataDirLockOwner }
  | { kind: 'stale'; owner: DataDirLockOwner }

export async function acquireDataDirLock(dataDir?: string, engineName = 'database'): Promise<() => Promise<void>> {
  if (!dataDir || dataDir.includes('://')) return async () => {}
  const absoluteDataDir = resolve(dataDir)
  const lockPath = `${absoluteDataDir}.supacloud-lite.lock`
  await mkdir(dirname(absoluteDataDir), { recursive: true, mode: 0o700 })
  const nonce = crypto.randomUUID()
  const handle = await createDataDirLock(absoluteDataDir, lockPath, nonce, engineName)
  let released = false
  return async () => {
    if (released) return
    released = true
    await handle.close()
    const owner = await readDataDirLockOwner(lockPath)
    if (owner?.nonce !== nonce) return
    await unlink(lockPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
}

export async function recoverStaleDataDirLock(lockPath: string): Promise<DataDirLockState> {
  const lockState = await inspectDataDirLock(lockPath)
  if (lockState.kind !== 'stale') return lockState

  try {
    await unlink(lockPath)
    return { kind: 'missing' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    throw error
  }
}

export async function readDataDirLockOwner(lockPath: string): Promise<DataDirLockOwner | null> {
  const lockState = await inspectDataDirLock(lockPath)
  return lockState.kind === 'active' || lockState.kind === 'stale' ? lockState.owner : null
}

export async function assertDataDirUnlocked(dataDir?: string): Promise<void> {
  if (!dataDir) return
  const lockPath = `${resolve(dataDir)}.supacloud-lite.lock`
  const lockState = await recoverStaleDataDirLock(lockPath)
  if (lockState.kind === 'missing') return
  if (lockState.kind === 'active') {
    throw new Error(`database data directory is already in use: ${resolve(dataDir)} (pid ${lockState.owner.pid})`)
  }
  throw unreadableLockError(lockPath, 'database')
}

async function createDataDirLock(
  absoluteDataDir: string,
  lockPath: string,
  nonce: string,
  engineName: string
): Promise<FileHandle> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await writeDataDirLock(lockPath, nonce)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const lockState = await recoverStaleDataDirLock(lockPath)
      if (lockState.kind === 'active') {
        throw new Error(`${engineName} data directory is already in use: ${absoluteDataDir} (pid ${lockState.owner.pid})`)
      }
      if (lockState.kind === 'unreadable') throw unreadableLockError(lockPath, engineName)
    }
  }
  throw unreadableLockError(lockPath, engineName)
}

async function writeDataDirLock(lockPath: string, nonce: string): Promise<FileHandle> {
  const handle = await open(lockPath, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, nonce, createdAt: new Date().toISOString() })}\n`)
    return handle
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(lockPath).catch(() => {})
    throw error
  }
}

function unreadableLockError(lockPath: string, engineName: string): Error {
  return new Error(
    `${engineName} data directory has an unreadable lock: ${lockPath}. ` +
      'Confirm no SupaCloud Lite process is using it, then remove the lock manually.'
  )
}

async function inspectDataDirLock(lockPath: string): Promise<DataDirLockState> {
  let contents: string
  try {
    contents = await readFile(lockPath, 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable' }
  }
  const owner = parseDataDirLockOwner(contents)
  if (!owner) return { kind: 'unreadable' }
  return isProcessAlive(owner.pid) ? { kind: 'active', owner } : { kind: 'stale', owner }
}

function parseDataDirLockOwner(contents: string): DataDirLockOwner | null {
  try {
    const value = JSON.parse(contents) as { pid?: unknown; nonce?: unknown }
    return typeof value.pid === 'number' && Number.isInteger(value.pid) && value.pid > 0 && typeof value.nonce === 'string'
      ? { pid: value.pid, nonce: value.nonce }
      : null
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
