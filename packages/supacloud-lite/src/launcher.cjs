#!/usr/bin/env node
'use strict'

const { spawn } = require('node:child_process')
const { join } = require('node:path')

const cliPath = join(__dirname, 'cli.js')
const bunProcess = spawn('bun', [cliPath, ...process.argv.slice(2)], { shell: false, stdio: 'inherit' })

bunProcess.once('error', (error) => {
  if (error.code === 'ENOENT') {
    console.error('Bun executable not found on PATH. Install Bun 1.3.14 or newer, then retry.')
  } else {
    console.error(`Unable to start Bun: ${error.message}`)
  }
  process.exitCode = 1
})

bunProcess.once('exit', (exitCode, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = exitCode ?? 1
})
