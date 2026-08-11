import { expect, test } from 'bun:test'
import { executeBufferedCommand } from '../scripts/subprocess.js'

const bunExecutable = Bun.which('bun')
if (!bunExecutable) throw new Error('Bun is required to run subprocess tests')

test('drains both output pipes while waiting for a command to exit', async () => {
  const outputBytes = 2 * 1024 * 1024
  const execution = await executeBufferedCommand({
    command: [bunExecutable, '-e', `
      const output = 'x'.repeat(${outputBytes})
      process.stdout.write(output)
      process.stderr.write(output)
    `],
    cwd: import.meta.dir,
    env: process.env,
    timeoutMs: 5_000,
  })

  expect(execution.exitCode).toBe(0)
  expect(execution.timedOut).toBe(false)
  expect(execution.stdout).toHaveLength(outputBytes)
  expect(execution.stderr).toHaveLength(outputBytes)
}, 10_000)

test('force-terminates a command at its bounded timeout', async () => {
  const startedAt = performance.now()
  const execution = await executeBufferedCommand({
    command: [bunExecutable, '-e', 'await Bun.sleep(30_000)'],
    cwd: import.meta.dir,
    env: process.env,
    timeoutMs: 100,
  })

  expect(execution.timedOut).toBe(true)
  expect(execution.exitCode).not.toBe(0)
  expect(performance.now() - startedAt).toBeLessThan(5_000)
}, 10_000)
