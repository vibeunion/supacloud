interface ShutdownSignalSource {
  off(signal: NodeJS.Signals, listener: () => void): void
  once(signal: NodeJS.Signals, listener: () => void): void
}

export async function waitForShutdown(
  closeProject: () => Promise<void>,
  signalSource: ShutdownSignalSource = process,
): Promise<void> {
  await new Promise<void>((resolveShutdown) => {
    const resolveOnSignal = () => {
      signalSource.off('SIGINT', resolveOnSignal)
      signalSource.off('SIGTERM', resolveOnSignal)
      resolveShutdown()
    }
    signalSource.once('SIGINT', resolveOnSignal)
    signalSource.once('SIGTERM', resolveOnSignal)
  })
  await closeProject()
}
