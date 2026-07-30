import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const launcherSourcePath = resolve(import.meta.dir, '../src/launcher.cjs')

test('waits for a SIGINT-shutdown child and preserves its successful exit code', async () => {
  const nodeExecutable = Bun.which('node')
  if (!nodeExecutable) throw new Error('Node is required to exercise the npm launcher')

  const packageDir = await mkdtemp(join(tmpdir(), 'supacloud-lite-launcher-'))
  const fakeBinDir = join(packageDir, 'bin')
  const launcherPath = join(packageDir, 'launcher.cjs')
  const cliPath = join(packageDir, 'cli.js')
  let launcher: Bun.Subprocess | undefined
  let launcherStopped = false

  try {
    await mkdir(fakeBinDir)
    await Bun.write(launcherPath, Bun.file(launcherSourcePath))
    await writeFile(cliPath, `
process.stdout.write('ready\\n')
process.once('SIGINT', () => setTimeout(() => process.exit(0), 10))
setInterval(() => {}, 1_000)
`)
    await Bun.write(join(fakeBinDir, 'bun.cjs'), `require(process.argv[2])\n`)
    await writeFakeBunCommand(fakeBinDir, nodeExecutable)

    launcher = Bun.spawn({
      cmd: [nodeExecutable, launcherPath, 'start'],
      cwd: packageDir,
      env: withFakeBunPath(fakeBinDir),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const launcherOutput = launcher.stdout
    if (!launcherOutput || typeof launcherOutput === 'number') throw new Error('launcher stdout is unavailable')
    await waitForOutput(launcherOutput as ReadableStream<Uint8Array>, 'ready')

    process.kill(launcher.pid, 'SIGINT')
    expect(await launcher.exited).toBe(0)
    launcherStopped = true
  } finally {
    if (launcher && !launcherStopped) {
      try {
        process.kill(launcher.pid, 'SIGTERM')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
      await launcher.exited
    }
    await rm(packageDir, { recursive: true, force: true })
  }
}, 20_000)

async function writeFakeBunCommand(fakeBinDir: string, nodeExecutable: string): Promise<void> {
  if (process.platform === 'win32') {
    await writeFile(join(fakeBinDir, 'bun.cmd'), `@"${nodeExecutable}" "%~dp0bun.cjs" %*\r\n`)
    return
  }

  const commandPath = join(fakeBinDir, 'bun')
  await writeFile(commandPath, `#!${nodeExecutable}\nrequire(__dirname + '/bun.cjs')\n`)
  await chmod(commandPath, 0o755)
}

function withFakeBunPath(fakeBinDir: string): NodeJS.ProcessEnv {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  return { ...process.env, [pathKey]: `${fakeBinDir}${delimiter}${process.env[pathKey] ?? ''}` }
}

async function waitForOutput(output: ReadableStream<Uint8Array>, expected: string): Promise<void> {
  const reader = output.getReader()
  const decoder = new TextDecoder()
  let logs = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error(`launcher exited before ${expected}:\n${logs}`)
      logs += decoder.decode(chunk.value, { stream: true })
      if (logs.includes(expected)) return
    }
  } finally {
    reader.releaseLock()
  }
}
