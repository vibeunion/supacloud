/**
 * Bun 1.3.14 stops polling Windows IOCP when only a subprocess exit is pending.
 * Remove this compatibility hold after the stable runtime includes oven-sh/bun#34478.
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
