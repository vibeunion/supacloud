import { stableJobKey } from "./job-policy.js";

export interface BackfillWindow {
  readonly scheduleId: string;
  readonly intervalSeconds: number;
  readonly from: Date;
  readonly to: Date;
  readonly limit?: number;
}

export function scheduledJobKey(scheduleId: string, occurrence: Date): string {
  if (!/^[A-Za-z0-9_.:@/-]{1,200}$/.test(scheduleId) || !Number.isFinite(occurrence.valueOf())) {
    throw new Error("WORKER_SCHEDULE_INVALID");
  }
  return stableJobKey("schedule", `${scheduleId}:${occurrence.toISOString()}`);
}

export function backfillOccurrences(window: BackfillWindow): Date[] {
  if (!Number.isSafeInteger(window.intervalSeconds) || window.intervalSeconds < 1
    || !Number.isFinite(window.from.valueOf()) || !Number.isFinite(window.to.valueOf())
    || window.to < window.from || window.limit !== undefined
    && (!Number.isSafeInteger(window.limit) || window.limit < 1 || window.limit > 10000)) {
    throw new Error("WORKER_SCHEDULE_INVALID");
  }
  const result: Date[] = [];
  const limit = window.limit ?? 1000;
  for (let current = window.from.valueOf(); current <= window.to.valueOf(); current += window.intervalSeconds * 1000) {
    if (result.length >= limit) throw new Error("WORKER_SCHEDULE_BACKFILL_LIMIT");
    result.push(new Date(current));
  }
  return result;
}
