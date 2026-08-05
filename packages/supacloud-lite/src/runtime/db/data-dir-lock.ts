import { readFile, unlink } from 'node:fs/promises'

export interface DataDirLockOwner {
  pid: number
  nonce: string
}

export type DataDirLockState =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'active'; owner: DataDirLockOwner }
  | { kind: 'stale'; owner: DataDirLockOwner }

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
