import { describe, expect, test } from "bun:test";
import { summarizeFunctionTasks } from "./function-task-summary";
import type { FunctionTaskRecord } from "./function-snippets";

describe("function task summary", () => {
  test("summarizeFunctionTasks groups running, retry, DLQ, failed, and cancelled counts", () => {
    const tasks: FunctionTaskRecord[] = [
      {
        id: "tsk_1",
        status: "running",
        function_slug: "image-render",
        attempt: 1,
        max_attempts: 3,
        error: null,
        updated_at: "2026-04-17T12:00:00.000Z",
        created_at: "2026-04-17T11:59:00.000Z",
      },
      {
        id: "tsk_2",
        status: "leased",
        function_slug: "image-render",
        attempt: 1,
        max_attempts: 3,
        error: null,
        updated_at: "2026-04-17T12:01:00.000Z",
        created_at: "2026-04-17T12:00:30.000Z",
      },
      {
        id: "tsk_3",
        status: "retry_scheduled",
        function_slug: "image-render",
        attempt: 2,
        max_attempts: 3,
        error: "upstream timeout",
        updated_at: "2026-04-17T12:02:00.000Z",
        created_at: "2026-04-17T12:01:00.000Z",
      },
      {
        id: "tsk_4",
        status: "dead_lettered",
        function_slug: "image-render",
        attempt: 3,
        max_attempts: 3,
        error: "provider rejected payload",
        updated_at: "2026-04-17T12:03:00.000Z",
        created_at: "2026-04-17T12:02:00.000Z",
      },
      {
        id: "tsk_5",
        status: "failed",
        function_slug: "image-render",
        attempt: 1,
        max_attempts: 1,
        error: "invalid auth",
        updated_at: "2026-04-17T12:04:00.000Z",
        created_at: "2026-04-17T12:03:00.000Z",
      },
      {
        id: "tsk_6",
        status: "cancelled",
        function_slug: "image-render",
        attempt: 1,
        max_attempts: 3,
        error: "Cancelled by user",
        updated_at: "2026-04-17T12:05:00.000Z",
        created_at: "2026-04-17T12:04:00.000Z",
      },
    ];

    const summary = summarizeFunctionTasks(tasks);

    expect(summary.running).toBe(2);
    expect(summary.retryScheduled).toBe(1);
    expect(summary.deadLettered).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.cancelled).toBe(1);
    expect(summary.recentFailures.map((task) => task.id)).toEqual(["tsk_4", "tsk_5"]);
  });

  test("summarizeFunctionTasks returns zero counts for empty task list", () => {
    expect(summarizeFunctionTasks([])).toEqual({
      running: 0,
      retryScheduled: 0,
      deadLettered: 0,
      failed: 0,
      cancelled: 0,
      recentFailures: [],
    });
  });
});
