function invalid(): never { throw new Error("Invalid task statistics"); }
export function statisticsCount(value: unknown): number {
  const parsed = typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : invalid();
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value)) : invalid();
}
function text(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value : invalid();
}
export interface TaskStatistics {
  running: number;
  retryScheduled: number;
  deadLettered: number;
  failedLast24h: number;
  cancelledLast24h: number;
  topFailures: { message: string; count: number }[];
  failedTrend: { bucket: string; failures: number }[];
}
export function readTaskStatistics(value: unknown): TaskStatistics {
  const row = record(value);
  if (!Array.isArray(row.topFailures) || row.topFailures.length > 5
    || !Array.isArray(row.failedTrend) || row.failedTrend.length > 25) return invalid();
  const messages = new Set<string>();
  const buckets = new Set<string>();
  return {
    running: statisticsCount(row.running), retryScheduled: statisticsCount(row.retryScheduled),
    deadLettered: statisticsCount(row.deadLettered), failedLast24h: statisticsCount(row.failedLast24h),
    cancelledLast24h: statisticsCount(row.cancelledLast24h),
    topFailures: row.topFailures.map((value: unknown) => {
      const item = record(value);
      const message = text(item.message);
      if (messages.has(message)) return invalid();
      messages.add(message);
      return { message, count: statisticsCount(item.count) };
    }),
    failedTrend: row.failedTrend.map((value: unknown) => {
      const item = record(value);
      const bucket = text(item.bucket);
      if (!/^(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):00$/.test(bucket)
        || buckets.has(bucket)) return invalid();
      buckets.add(bucket);
      return { bucket, failures: statisticsCount(item.failures) };
    }),
  };
}
