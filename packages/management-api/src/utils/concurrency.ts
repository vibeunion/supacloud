export function parseConcurrency(value: string | undefined, fallback: number): number {
  const concurrency = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Concurrency must be a positive safe integer");
  }
  return concurrency;
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Concurrency must be a positive safe integer");
  }
  for (let index = 0; index < items.length; index++) {
    if (!Object.hasOwn(items, index)) throw new TypeError("Batch items must not be sparse");
  }
  const snapshot = [...items];
  const entries = snapshot.entries();
  const results = new Array<R>(snapshot.length);
  let failure: { reason: unknown } | undefined;
  // Drain in-flight work before reporting failure; do not schedule more side effects.
  await Promise.all(Array.from({ length: Math.min(concurrency, snapshot.length) }, async () => {
    while (!failure) {
      const next = entries.next();
      if (next.done) return;
      const [index, item] = next.value;
      try {
        results[index] = await mapper(item, index);
      } catch (reason: unknown) {
        failure ??= { reason };
      }
    }
  }));
  if (failure) throw failure.reason;
  return results;
}
