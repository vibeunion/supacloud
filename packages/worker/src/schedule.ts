import { stableJobKey, validateJobKey } from "./job-policy.js";

export interface BackfillWindow {
  readonly scheduleId: string;
  readonly intervalSeconds: number;
  readonly from: Date;
  readonly to: Date;
  /** Fixed phase origin; defaults to the Unix epoch, not the polling window. */
  readonly anchor?: Date;
  readonly limit?: number;
}

function timestamp(value: Date): number {
  if (!(value instanceof Date)) throw new Error("WORKER_SCHEDULE_INVALID");
  const result = Date.prototype.getTime.call(value);
  if (!Number.isSafeInteger(result)) throw new Error("WORKER_SCHEDULE_INVALID");
  return result;
}

export function scheduledJobKey(scheduleId: string, occurrence: Date): string {
  try {
    return stableJobKey("schedule", `${validateJobKey(scheduleId)}:${new Date(timestamp(occurrence)).toISOString()}`);
  } catch { throw new Error("WORKER_SCHEDULE_INVALID"); }
}

export function backfillOccurrences(window: BackfillWindow): Date[] {
  if (!window || typeof window !== "object") throw new Error("WORKER_SCHEDULE_INVALID");
  const from = timestamp(window.from);
  const to = timestamp(window.to);
  const anchor = window.anchor === undefined ? 0 : timestamp(window.anchor);
  scheduledJobKey(window.scheduleId, new Date(from));
  const interval = window.intervalSeconds * 1000;
  const limit = window.limit === undefined ? 1000 : window.limit;
  if (!Number.isSafeInteger(window.intervalSeconds) || window.intervalSeconds < 1
    || !Number.isSafeInteger(interval) || to < from
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000) {
    throw new Error("WORKER_SCHEDULE_INVALID");
  }
  const step = BigInt(interval);
  const offset = BigInt(from) - BigInt(anchor);
  const remainder = ((offset % step) + step) % step;
  const first = BigInt(from) + (remainder === 0n ? 0n : step - remainder);
  const end = BigInt(to);
  const count = first > end ? 0n : (end - first) / step + 1n;
  if (count > BigInt(limit)) throw new Error("WORKER_SCHEDULE_BACKFILL_LIMIT");
  const result: Date[] = [];
  for (let current = first; current <= end; current += step) {
    const occurrence = new Date(Number(current));
    scheduledJobKey(window.scheduleId, occurrence);
    result.push(occurrence);
  }
  return result;
}
