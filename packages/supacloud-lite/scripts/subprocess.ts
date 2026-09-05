/**
 * Keep subprocess collection bounded for external Bun consumers while preserving
 * the stable runtime's Windows IOCP behavior.
 */
export async function withWindowsSubprocessRef<T>(operation: () => Promise<T>): Promise<T> {
  if (process.platform !== 'win32') return await operation()
  const eventLoopRef = setInterval(() => {}, 1000)
  try {
    return await operation()
  } finally {
    clearInterval(eventLoopRef)
  }
}

export interface BufferedCommandOptions {
  command: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
}

export interface BufferedCommandExecution {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export async function executeBufferedCommand(options: BufferedCommandOptions): Promise<BufferedCommandExecution> {
  const timeoutController = new AbortController()
  const processHandle = spawnBufferedCommand(options, timeoutController.signal)
  let timedOut: boolean = false
  const timeout = setTimeout(() => {
    timedOut = true
    timeoutController.abort()
  }, options.timeoutMs)
  try {
    const [exitCode, stdout, stderr] = await collectBufferedCommand(processHandle)
    return { exitCode, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timeout)
  }
}

function spawnBufferedCommand(options: BufferedCommandOptions, signal: AbortSignal) {
  return Bun.spawn({
    cmd: options.command,
    cwd: options.cwd,
    env: options.env,
    stdout: 'pipe',
    stderr: 'pipe',
    signal,
    killSignal: 'SIGKILL',
  })
}

async function collectBufferedCommand(processHandle: ReturnType<typeof spawnBufferedCommand>) {
  return await withWindowsSubprocessRef(() => Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]))
}
