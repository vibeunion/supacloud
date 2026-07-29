import { expect, test } from 'bun:test'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const cliPath = resolve(import.meta.dir, '../src/cli.ts')

test('closes the project and releases its data lock on SIGINT', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-cli-shutdown-'))
  const lockPath = join(projectDir, '.supacloud-lite', 'db.supacloud-lite.lock')
  const firstRun = startCli(projectDir)
  let firstStopped = false
  let restartedRun: ReturnType<typeof startCli> | undefined
  let restartedStopped = false

  try {
    await firstRun.ready
    await access(lockPath)
    expect(await stopCli(firstRun, 'SIGINT')).toBe(0)
    firstStopped = true
    await expect(access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

    restartedRun = startCli(projectDir)
    await restartedRun.ready
    await access(lockPath)
    expect(await stopCli(restartedRun, 'SIGINT')).toBe(0)
    restartedStopped = true
  } finally {
    await Promise.all([
      firstStopped ? undefined : stopCli(firstRun, 'SIGTERM'),
      restartedStopped || !restartedRun ? undefined : stopCli(restartedRun, 'SIGTERM'),
    ])
    await rm(projectDir, { recursive: true, force: true })
  }
}, 60_000)

function startCli(projectDir: string) {
  const bunExecutable = Bun.which('bun')
  if (!bunExecutable) throw new Error('Bun is required to run the Lite CLI test')
  const processHandle = Bun.spawn({
    cmd: [bunExecutable, cliPath, 'start', '--project-dir', projectDir, '--port', '0'],
    cwd: projectDir,
    stdout: 'pipe',
    stderr: 'ignore',
  })
  return { processHandle, ready: waitForStartup(processHandle.stdout) }
}

async function stopCli(cliRun: ReturnType<typeof startCli>, signal: NodeJS.Signals): Promise<number> {
  try {
    process.kill(cliRun.processHandle.pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
  return await cliRun.processHandle.exited
}

async function waitForStartup(logs: ReadableStream<Uint8Array>): Promise<void> {
  const reader = logs.getReader()
  const decoder = new TextDecoder()
  let output = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error(`Lite CLI exited before startup:\n${output}`)
      output += decoder.decode(chunk.value, { stream: true })
      if (output.includes('SupaCloud Lite running')) return
    }
  } finally {
    reader.releaseLock()
  }
}
