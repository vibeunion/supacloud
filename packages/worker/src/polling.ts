export interface AdaptivePollingOptions {
  minIntervalMs?: number;
  maxIntervalMs?: number;
  idleBackoffFactor?: number;
}

export type AdaptivePollInterval = (messageCount?: number) => number;

/**
 * Returns a stateful interval policy for the patched pgflow poller. A busy
 * queue immediately returns to the minimum interval; empty polls back off
 * multiplicatively until the configured ceiling.
 */
export function adaptivePollInterval(options: AdaptivePollingOptions = {}): AdaptivePollInterval {
  const min = options.minIntervalMs ?? 25;
  const max = options.maxIntervalMs ?? 1000;
  const factor = options.idleBackoffFactor ?? 1.5;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max < min
    || !Number.isFinite(factor) || factor < 1 || factor > 4) {
    throw new Error("WORKER_POLLING_INVALID");
  }
  let current = min;
  return messageCount => {
    if (messageCount === undefined) return current;
    current = messageCount > 0 ? min : Math.min(max, Math.max(min, Math.ceil(current * factor)));
    return current;
  };
}
