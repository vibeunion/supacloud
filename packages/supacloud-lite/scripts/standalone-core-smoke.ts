/**
 * Start a standalone binary once to prove the embedded Rust Realtime core can
 * be extracted and loaded. `gen types` intentionally skips serving, so it
 * cannot validate the core.
 */
import { resolve } from 'node:path'

const binary = process.argv[2]
if (!binary) throw new Error('usage: bun run scripts/standalone-core-smoke.ts <supacloud-lite binary>')

const started = Bun.spawn([resolve(binary), 'start', '--memory', '--port', '0'], {
  stdout: 'pipe',
  stderr: 'pipe',
})

let output = ''
let errors = ''
const decoder = new TextDecoder()
const timer = setTimeout(() => started.kill(), 30_000)

try {
  const reader = started.stdout.getReader()
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    output += decoder.decode(value, { stream: true })
    if (output.includes('SupaCloud Lite running')) break
  }
  if (!output.includes('SupaCloud Lite running')) {
    errors = await new Response(started.stderr).text()
    throw new Error(`standalone start failed\nstdout:\n${output}\nstderr:\n${errors}`)
  }
  console.log('standalone Realtime core loaded')
} finally {
  clearTimeout(timer)
  started.kill()
  await started.exited
}
