import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { waitForShutdown } from '../src/shutdown.js'
import { withWindowsSubprocessRef } from '../scripts/subprocess.js'

const cliPath = resolve(import.meta.dir, '../src/cli.ts')

test('closes the project and releases its data lock on SIGINT', async () => {
  if (process.platform === 'win32') {
    // Windows process.kill terminates a child instead of emulating terminal Ctrl+C.
    await assertShutdownHandlerClosesProject('SIGINT')
    return
  }

  const projectDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-cli-shutdown-'))
  const lockPath = join(projectDir, '.supacloud-lite', 'db.supacloud-lite.lock')
  const firstRun = startCli(projectDir)
  let firstStopped = false
  let restartedRun: ReturnType<typeof startCli> | undefined
  let restartedStopped = false

  try {
    await firstRun.ready
    await access(lockPath)
    for (const command of [['inspect'], ['db', 'diff'], ['db', 'pull']]) {
      const blockedRun = await runCli(projectDir, command)
      expect(blockedRun.exitCode).toBe(1)
      expect(blockedRun.stderr.match(/PGlite data directory is already in use/g)).toHaveLength(1)
      expect(blockedRun.stderr).not.toContain('\n    at ')
      expect(blockedRun.durationMs).toBeLessThan(10_000)
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
  if (process.platform === 'win32') {
    // Windows process.kill terminates a child instead of delivering SIGTERM.
    await assertShutdownHandlerClosesProject('SIGTERM')
    return
  }

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

test('propagates a project cleanup failure', async () => {
  const signalSource = new EventEmitter()
  const expectedError = new Error('close failed')
  const shutdown = waitForShutdown(() => Promise.reject(expectedError), signalSource)

  signalSource.emit('SIGINT')
  await expect(shutdown).rejects.toBe(expectedError)
})

test('runs project cleanup once after duplicate signals', async () => {
  await assertShutdownHandlerClosesProject('SIGINT')
})

test('keeps the Windows CLI referenced through output and clears it before exit', async () => {
  const probeDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-windows-lifecycle-'))
  const eventsPath = join(probeDir, 'events.log')
  const preloadPath = join(probeDir, 'preload.js')

  try {
    await writeFile(preloadPath, WINDOWS_LIFECYCLE_PROBE)
    const cliRun = await runCliWithPreload(preloadPath, eventsPath)
    expect(cliRun.exitCode).toBe(0)
    expect(cliRun.stderr).toBe('')
    expect(cliRun.stdout).not.toBe('')
    expect(await readFile(eventsPath, 'utf8')).toBe('ref\nstdout\nclear\nexit:0\n')
  } finally {
    await rm(probeDir, { recursive: true, force: true })
  }
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
  const startedAt = performance.now()
  const processHandle = Bun.spawn({
    cmd: [bunExecutable, cliPath, ...command, '--project-dir', projectDir],
    cwd: projectDir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await withWindowsSubprocessRef(() => Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]))
  return { exitCode, stdout, stderr, durationMs: performance.now() - startedAt }
}

async function runCliWithPreload(preloadPath: string, eventsPath: string) {
  const bunExecutable = Bun.which('bun')
  if (!bunExecutable) throw new Error('Bun is required to run the Lite CLI test')
  const processHandle = Bun.spawn({
    cmd: [bunExecutable, '--preload', preloadPath, cliPath, 'version'],
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, SUPACLOUD_LITE_LIFECYCLE_EVENTS: eventsPath },
  })
  const [exitCode, stdout, stderr] = await withWindowsSubprocessRef(() => Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]))
  return { exitCode, stdout, stderr }
}

async function stopCli(cliRun: ReturnType<typeof startCli>, signal: NodeJS.Signals): Promise<number> {
  try {
    process.kill(cliRun.processHandle.pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
  return await withWindowsSubprocessRef(() => cliRun.processHandle.exited)
}

async function assertShutdownHandlerClosesProject(signal: NodeJS.Signals): Promise<void> {
  const signalSource = new EventEmitter()
  let closeCalls = 0
  let allowClose: (() => void) | undefined
  const closeFinished = new Promise<void>((resolveClose) => {
    allowClose = resolveClose
  })
  const shutdown = waitForShutdown(async () => {
    closeCalls += 1
    await closeFinished
  }, signalSource)

  signalSource.emit(signal)
  signalSource.emit(signal)
  await Promise.resolve()
  expect(closeCalls).toBe(1)
  allowClose!()
  await shutdown
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

const WINDOWS_LIFECYCLE_PROBE = `
import { appendFileSync } from 'node:fs'

const eventsPath = process.env.SUPACLOUD_LITE_LIFECYCLE_EVENTS
if (!eventsPath) throw new Error('missing lifecycle events path')
const record = (event) => appendFileSync(eventsPath, event + '\\n')
const nativeSetInterval = globalThis.setInterval.bind(globalThis)
const nativeClearInterval = globalThis.clearInterval.bind(globalThis)
const nativeWrite = Bun.write.bind(Bun)
const nativeExit = process.exit.bind(process)
let lifecycleRef

process.platform = 'win32'
globalThis.setInterval = (callback, delay, ...args) => {
  const timer = nativeSetInterval(callback, delay, ...args)
  if (delay === 1000 && lifecycleRef === undefined) {
    lifecycleRef = timer
    record('ref')
  }
  return timer
}
globalThis.clearInterval = (timer) => {
  if (timer === lifecycleRef) record('clear')
  return nativeClearInterval(timer)
}
Bun.write = async (destination, input) => {
  const bytesWritten = await nativeWrite(destination, input)
  if (destination === Bun.stdout) record('stdout')
  return bytesWritten
}
process.exit = (code) => {
  record('exit:' + (code ?? 0))
  return nativeExit(code)
}
`
