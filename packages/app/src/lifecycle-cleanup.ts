/** Internal lifecycle utilities; no DI, transport or public application model. */
export type Cleanup = () => void | Promise<void>;

/** Run every cleanup, in order, even when an earlier cleanup fails. */
export async function runCleanup(operations: readonly Cleanup[], message: string): Promise<void> {
  const errors: unknown[] = [];
  for (const operation of operations) {
    try {
      const pending = operation();
      // Preserve synchronous cancellation after synchronous cleanup phases.
      if (pending !== undefined) await pending;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, message);
}

/** Preserve the primary failure, including non-Error throws, when cleanup also fails. */
export async function withCleanup<T>(
  work: () => T | Promise<T>,
  cleanup: Cleanup,
  message: string,
): Promise<T> {
  let result: T;
  try {
    result = await work();
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], message, { cause: error });
    }
    throw error;
  }
  await cleanup();
  return result;
}
