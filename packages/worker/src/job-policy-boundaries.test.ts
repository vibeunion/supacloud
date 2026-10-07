import { expect, test } from "bun:test";
import { normalizeJobPolicy, retryDelaySeconds, stableJobKey, validateJobKey } from "./job-policy.js";
import { pgmqWakeupChannel, createPgmqWakeup } from "./wakeup.js";
import { scheduledJobKey, backfillOccurrences } from "./schedule.js";
import { runTaskListOnce } from "./task-list-once.js";
import { createQueueJobMetrics } from "./job-metrics.js";

test("job keys remain valid after namespacing and reject trailing newlines", () => {
  expect(validateJobKey(stableJobKey("jobs", "a".repeat(195)))).toHaveLength(200);
  expect(() => stableJobKey("jobs", "a".repeat(196))).toThrow("WORKER_JOB_KEY_INVALID");
  for (const key of ["job\n", "job\r", " job", "a".repeat(201)]) {
    expect(() => validateJobKey(key)).toThrow("WORKER_JOB_KEY_INVALID");
  }
});

test("retry budgets mean retries, keep zero distinct, and validate runtime policy values", () => {
  const policy = normalizeJobPolicy({ maxRetries: 2, baseDelaySeconds: 3, maxDelaySeconds: 10 });
  expect([1, 2, 3].map(attempt => retryDelaySeconds(policy, attempt))).toEqual([3, 6, 0]);
  expect(retryDelaySeconds(normalizeJobPolicy({ maxRetries: 0 }), 1)).toBe(0);
  for (const value of [null, [], { maxRetries: null }, { maxRetries: -1 }, { maxAttempts: 3 }]) {
    expect(() => normalizeJobPolicy(value as never)).toThrow("WORKER_RETRY_POLICY_INVALID");
  }
  expect(() => retryDelaySeconds({ ...policy, maxDelaySeconds: NaN }, 1)).toThrow("WORKER_RETRY_POLICY_INVALID");
});

test("overlapping backfill windows retain a fixed schedule phase", () => {
  const base = { scheduleId: "hourly", intervalSeconds: 3600, to: new Date("2026-10-07T02:59:00Z") };
  const first = backfillOccurrences({ ...base, from: new Date("2026-10-07T00:01:00Z") });
  const second = backfillOccurrences({ ...base, from: new Date("2026-10-07T01:01:00Z") });
  expect(first.map(value => value.toISOString())).toEqual(["2026-10-07T01:00:00.000Z", "2026-10-07T02:00:00.000Z"]);
  expect(second.map(value => scheduledJobKey("hourly", value))).toEqual([scheduledJobKey("hourly", first[1]!)]);
  expect(() => backfillOccurrences({ ...base, scheduleId: "", from: new Date(0) })).toThrow("WORKER_SCHEDULE_INVALID");
  expect(() => backfillOccurrences({ ...base, intervalSeconds: Number.MAX_SAFE_INTEGER, from: new Date(0) })).toThrow("WORKER_SCHEDULE_INVALID");
  expect(() => backfillOccurrences({ ...base, from: new Date(0), limit: 1 })).toThrow("WORKER_SCHEDULE_BACKFILL_LIMIT");
  expect(() => scheduledJobKey("a".repeat(200), new Date())).toThrow("WORKER_SCHEDULE_INVALID");
});

test("notification channels fit PostgreSQL and cancellation does not start a wait", async () => {
  const prefix = "a".repeat(127);
  expect(pgmqWakeupChannel(`${prefix}x`)).not.toBe(pgmqWakeupChannel(`${prefix}y`));
  expect(Buffer.byteLength(pgmqWakeupChannel(`${prefix}x`))).toBeLessThanOrEqual(63);
  expect(() => pgmqWakeupChannel("jobs\n")).toThrow("WORKER_QUEUE_INVALID");
  let calls = 0;
  const wakeup = createPgmqWakeup({ async notify() {}, async wait() { calls++; } }, "jobs");
  const stop = new AbortController();
  const reason = new Error("stopped");
  stop.abort(reason);
  await expect(wakeup.wait(stop.signal)).rejects.toBe(reason);
  expect(calls).toBe(0);
});

test("local task lists reject invalid metadata before effects and redact prefixed exceptions", async () => {
  const binding = { projectRef: "project-a", queueName: "scw_reports", taskKey: "report.render" };
  let executions = 0;
  const handler = { decode: (input: unknown) => input, authorize: () => true,
    execute() { executions++; throw new Error("WORKER_SECRET synthetic-secret"); } };
  await expect(runTaskListOnce([{ messageId: "1", payload: {} }, { messageId: "2", payload: {}, attempt: 0 }], binding, handler))
    .rejects.toThrow("WORKER_TASK_INVALID");
  expect(executions).toBe(0);
  const results = await runTaskListOnce([{ messageId: "1", payload: {} }], binding, handler);
  expect(results).toEqual([{ messageId: "1", attempt: 1, status: "failed", code: "WORKER_TASK_FAILED" }]);
  const stop = new AbortController();
  const reason = new Error("stop after authorization");
  await expect(runTaskListOnce([{ messageId: "2", payload: {} }], binding,
    { ...handler, authorize() { stop.abort(reason); return true; } }, { signal: stop.signal })).rejects.toBe(reason);
  expect(executions).toBe(1);
});

test("queue age is an explicit observation rather than invented from completion counters", () => {
  const metrics = createQueueJobMetrics();
  metrics.enqueue(); metrics.enqueue(); metrics.start(); metrics.complete();
  expect(metrics.snapshot().oldestPendingAgeSeconds).toBeNull();
  expect(metrics.prometheus("jobs")).not.toContain("scw_queue_oldest_pending_age_seconds");
  metrics.observePending(0);
  expect(metrics.snapshot().oldestPendingAgeSeconds).toBeGreaterThan(0);
  metrics.observePending(null);
  expect(metrics.snapshot().oldestPendingAgeSeconds).toBe(0);
  const { prometheus } = metrics;
  expect(prometheus("jobs")).toContain('scw_queue_jobs_completed_total{queue="jobs"} 1');
  expect(() => prometheus('jobs"\nforged 1')).toThrow("WORKER_QUEUE_INVALID");
  expect(() => metrics.observePending(NaN)).toThrow("WORKER_QUEUE_METRICS_INVALID");
});
