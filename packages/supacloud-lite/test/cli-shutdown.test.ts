import { expect, test } from 'bun:test'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
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
    for (const command of [['inspect'], ['db', 'diff']]) {
      const blockedRun = await runCli(projectDir, command)
      expect(blockedRun.exitCode).toBe(1)
      expect(blockedRun.stderr.match(/PGlite data directory is already in use/g)).toHaveLength(1)
      expect(blockedRun.stderr).not.toContain('\n    at ')
    }
    expect(await stopCli(firstRun, 'SIGINT')).toBe(0)
    firstStopped = true
    await expect(access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

    restartedRun = startCli(projectDir)
    await restartedRun.ready
    await access(lockPath)
    expect(await stopCli(restartedRun, 'SIGINT')).toBe(0)
    restartedStopped = true
    await expect(access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await Promise.all([
      firstStopped ? undefined : stopCli(firstRun, 'SIGTERM'),
      restartedStopped || !restartedRun ? undefined : stopCli(restartedRun, 'SIGTERM'),
    ])
    await rm(projectDir, { recursive: true, force: true })
  }
}, 120_000)

test('closes the project and releases its data lock on SIGTERM', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-cli-shutdown-'))
  const lockPath = join(projectDir, '.supacloud-lite', 'db.supacloud-lite.lock')
  const cliRun = startCli(projectDir)
  let stopped = false

  try {
    await cliRun.ready
    await access(lockPath)
    expect(await stopCli(cliRun, 'SIGTERM')).toBe(0)
    stopped = true
    await expect(access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    if (!stopped) await stopCli(cliRun, 'SIGTERM')
    await rm(projectDir, { recursive: true, force: true })
  }
}, 60_000)

test('marks direct CLI shutdown success only after close resolves', async () => {
  const source = await readFile(cliPath, 'utf8')
  const shutdownCall = source.indexOf("await waitForShutdown(() => project.close())")
  const successfulExit = source.indexOf('process.exitCode = 0', shutdownCall)

  expect(shutdownCall).toBeGreaterThan(-1)
  expect(source.indexOf('await closeProject()')).toBeGreaterThan(shutdownCall)
  expect(successfulExit).toBeGreaterThan(shutdownCall)
  expect(source).toContain('process.exitCode = 1')
})

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

async function runCli(projectDir: string, command: string[]) {
  const bunExecutable = Bun.which('bun')
  if (!bunExecutable) throw new Error('Bun is required to run the Lite CLI test')
  const processHandle = Bun.spawn({
    cmd: [bunExecutable, cliPath, ...command, '--project-dir', projectDir],
    cwd: projectDir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
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
