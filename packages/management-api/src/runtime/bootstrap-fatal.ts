import { logger } from "../utils/logger";

export type FatalExit = (code: number) => never | void;
export type FatalLogger = (message: string, metadata: Record<string, unknown>) => void;

export function terminateFatalProcess(
  message: string,
  reason: unknown,
  exit: FatalExit = (code) => process.exit(code),
  log: FatalLogger = (entry, metadata) => logger.error(entry, metadata),
): void {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  log(message, { reason: error.message, stack: error.stack });
  exit(1);
}

export async function runBootstrapOrExit(
  bootstrap: () => Promise<void>,
  fatal: (message: string, reason: unknown) => void = terminateFatalProcess,
): Promise<void> {
  try {
    await bootstrap();
  } catch (error) {
    fatal("FATAL BOOTSTRAP FAILURE:", error);
  }
}
