import { symlink } from 'node:fs/promises'

export async function createSymlinkIfPermitted(target: string, linkPath: string): Promise<boolean> {
  try {
    await symlink(target, linkPath)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') return false
    throw error
  }
}
