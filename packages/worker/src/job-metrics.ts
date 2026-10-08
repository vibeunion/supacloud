export interface QueueJobMetrics {
  enqueued: number;
  started: number;
  completed: number;
  retried: number;
  unknown: number;
  /** Null until an authoritative queue observation is supplied. */
  oldestPendingAgeSeconds: number | null;
}

/** Explicit instrumentation only; counters cannot reconstruct queue membership. */
export function createQueueJobMetrics() {
  const counters = { enqueued: 0, started: 0, completed: 0, retried: 0, unknown: 0 };
  let oldestPendingAt: number | null | undefined;
  const snapshot = (): QueueJobMetrics => ({
    ...counters,
    oldestPendingAgeSeconds: oldestPendingAt === undefined ? null : oldestPendingAt === null
      ? 0 : Math.max(0, (Date.now() - oldestPendingAt) / 1000),
  });
  return {
    enqueue() { counters.enqueued++; },
    start() { counters.started++; },
    complete() { counters.completed++; },
    retry() { counters.retried++; },
    outcomeUnknown() { counters.unknown++; },
    /** Supply the actual oldest pending timestamp; null means a confirmed empty queue. */
    observePending(oldest: number | null) {
      if (oldest !== null && (!Number.isSafeInteger(oldest) || Math.abs(oldest) > 8640000000000000)) {
        throw new Error("WORKER_QUEUE_METRICS_INVALID");
      }
      oldestPendingAt = oldest;
    },
    snapshot,
    prometheus(queueName: string): string {
      if (typeof queueName !== "string" || queueName.trim() !== queueName
        || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(queueName)) throw new Error("WORKER_QUEUE_INVALID");
      const label = `queue="${queueName}"`;
      const current = snapshot();
      return [
        `scw_queue_jobs_enqueued_total{${label}} ${current.enqueued}`,
        `scw_queue_jobs_started_total{${label}} ${current.started}`,
        `scw_queue_jobs_completed_total{${label}} ${current.completed}`,
        `scw_queue_jobs_retried_total{${label}} ${current.retried}`,
        `scw_queue_jobs_unknown_total{${label}} ${current.unknown}`,
        ...(current.oldestPendingAgeSeconds === null ? []
          : [`scw_queue_oldest_pending_age_seconds{${label}} ${current.oldestPendingAgeSeconds}`]),
      ].join("\n") + "\n";
    },
  };
}
