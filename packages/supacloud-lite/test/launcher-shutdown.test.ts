import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

const launcherSourcePath = resolve(import.meta.dir, '../src/launcher.cjs')

test('forwards a graceful shutdown and preserves its successful exit code', async () => {
  const launcherSource = await readFile(launcherSourcePath, 'utf8')
  const parentProcess = createParentProcess()
  const bunProcess = createBunProcess()
  const require = createLauncherRequire(bunProcess)

  runInNewContext(launcherSource, { __dirname: import.meta.dir, console, process: parentProcess, require })
  parentProcess.emit('SIGINT')
  bunProcess.emit('exit', 0, null)

  expect(bunProcess.killCalls).toEqual(['SIGINT'])
  expect(parentProcess.exitCode).toBe(0)
})

function createParentProcess() {
  return Object.assign(new EventEmitter(), {
    argv: ['node', 'launcher.cjs', 'start'],
    exitCode: null as number | null,
    pid: 42,
    kill: () => {
      throw new Error('the launcher must not re-signal its parent')
    },
  })
}

function createBunProcess() {
  return Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killCalls: [] as NodeJS.Signals[],
    kill(signal: NodeJS.Signals) {
      this.killCalls.push(signal)
    },
  })
}

function createLauncherRequire(bunProcess: ReturnType<typeof createBunProcess>) {
  return (moduleName: string) => {
    if (moduleName === 'node:child_process') return { spawn: () => bunProcess }
    if (moduleName === 'node:path') return { join }
    throw new Error(`unexpected module: ${moduleName}`)
  }
}
