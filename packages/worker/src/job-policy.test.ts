import { describe, expect, test } from "bun:test";
import {
  normalizeJobPolicy,
  retryDelaySeconds,
  stableJobKey,
  validateJobKey,
} from "./job-policy.js";
import { runTaskListOnce } from "./task-list-once.js";
import { createPgmqWakeup, pgmqWakeupChannel } from "./wakeup.js";
import { backfillOccurrences, scheduledJobKey } from "./schedule.js";

describe("worker job policy", () => {
  test("normalizes bounded retry policy and calculates exponential delay", () => {
    const policy = normalizeJobPolicy({
      maxRetries: 4,
      baseDelaySeconds: 3,
      maxDelaySeconds: 10,
      priority: 7,
    });
    expect(policy).toEqual({
      maxRetries: 4,
      baseDelaySeconds: 3,
      maxDelaySeconds: 10,
      priority: 7,
    });
    expect([1, 2, 3, 4, 5].map(attempt => retryDelaySeconds(policy, attempt))).toEqual([3, 6, 10, 10, 0]);
    expect(stableJobKey("scw_reports", "report:42/revision:3")).toBe("scw_reports:report:42/revision:3");
  });

  test("rejects invalid keys and policy ranges", () => {
    for (const value of ["", " report", "report key", "a".repeat(201), null]) {
      expect(() => validateJobKey(value)).toThrow("WORKER_JOB_KEY_INVALID");
    }
    expect(() => normalizeJobPolicy({ baseDelaySeconds: 10, maxDelaySeconds: 2 }))
      .toThrow("WORKER_RETRY_POLICY_INVALID");
  });

  test("runs a finite task list without requiring a database", async () => {
    const seen: string[] = [];
    const result = await runTaskListOnce(
      [
        { messageId: "1", payload: { id: "ok" } },
        { messageId: "2", payload: { id: "no" } },
        { messageId: "3", payload: { invalid: true }, attempt: 2 },
      ],
      { projectRef: "project-a", queueName: "scw_reports", taskKey: "report.render" },
      {
        decode(value) {
          if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string") {
            throw new Error("WORKER_TASK_INVALID");
          }
          return value.id;
        },
        authorize(value) { return value === "ok"; },
        execute(value) { seen.push(value); },
      },
    );
    expect(result).toEqual([
      { messageId: "1", status: "succeeded", attempt: 1 },
      { messageId: "2", status: "failed", attempt: 1, code: "WORKER_TASK_FORBIDDEN" },
      { messageId: "3", status: "failed", attempt: 2, code: "WORKER_TASK_INVALID" },
    ]);
    expect(seen).toEqual(["ok"]);
  });

  test("supports stable scheduled identities and bounded backfill", () => {
    const occurrence = new Date("2026-10-07T00:00:00.000Z");
    expect(scheduledJobKey("reports.hourly", occurrence)).toBe(
      "schedule:reports.hourly:2026-10-07T00:00:00.000Z",
    );
    expect(backfillOccurrences({
      scheduleId: "reports.hourly",
      intervalSeconds: 3600,
      from: occurrence,
      to: new Date("2026-10-07T02:00:00.000Z"),
    }).map(value => value.toISOString())).toEqual([
      "2026-10-07T00:00:00.000Z",
      "2026-10-07T01:00:00.000Z",
      "2026-10-07T02:00:00.000Z",
    ]);
  });

  test("uses a queue-scoped LISTEN/NOTIFY transport without changing PGMQ RPCs", async () => {
    const signals: string[] = [];
    const wakeup = createPgmqWakeup({
      async notify(channel, payload) { signals.push(`${channel}:${payload}`); },
      async wait(channel) { signals.push(`wait:${channel}`); },
    }, "scw_reports");
    await wakeup.signal("report:42");
    await wakeup.wait(new AbortController().signal);
    expect(signals).toEqual([
      `${pgmqWakeupChannel("scw_reports")}:report:42`,
      `wait:${pgmqWakeupChannel("scw_reports")}`,
    ]);
  });
});
