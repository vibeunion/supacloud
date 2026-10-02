#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url))
const bunProcess = spawn('bun', [cliPath, ...process.argv.slice(2)], { shell: false, stdio: 'inherit' })
let requestedShutdownSignal = null

function forwardShutdownSignal(signal) {
  if (requestedShutdownSignal || bunProcess.exitCode !== null || bunProcess.signalCode !== null) return
  requestedShutdownSignal = signal
  bunProcess.kill(signal)
}

const forwardSigint = () => forwardShutdownSignal('SIGINT')
const forwardSigterm = () => forwardShutdownSignal('SIGTERM')
process.once('SIGINT', forwardSigint)
process.once('SIGTERM', forwardSigterm)

function cleanup() {
  process.off('SIGINT', forwardSigint)
  process.off('SIGTERM', forwardSigterm)
}

bunProcess.once('error', (error) => {
  cleanup()
  if (error.code === 'ENOENT') {
    console.error('Bun executable not found on PATH. Install Bun 1.4.2 or newer, then retry.')
  } else {
    console.error(`Unable to start Bun: ${error.message}`)
  }
  process.exitCode = 1
})

bunProcess.once('exit', (exitCode, signal) => {
  cleanup()
  process.exitCode = exitCode ?? (requestedShutdownSignal === signal ? 0 : 1)
})
