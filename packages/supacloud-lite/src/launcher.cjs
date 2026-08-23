#!/usr/bin/env node
'use strict'

const { spawn } = require('node:child_process')
const { join } = require('node:path')

const cliPath = join(__dirname, 'cli.js')
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

bunProcess.once('error', (error) => {
  if (error.code === 'ENOENT') {
    console.error('Bun executable not found on PATH. Install Bun 1.4.0 or newer, then retry.')
  } else {
    console.error(`Unable to start Bun: ${error.message}`)
  }
  process.exitCode = 1
})

bunProcess.once('exit', (exitCode, signal) => {
  process.off('SIGINT', forwardSigint)
  process.off('SIGTERM', forwardSigterm)
  process.exitCode = exitCode ?? (requestedShutdownSignal === signal ? 0 : 1)
})
