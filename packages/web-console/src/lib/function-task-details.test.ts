import { describe, expect, test } from "bun:test";
import { getTaskLatestLogPreview, hasTaskLogPreview } from "./function-task-details";
import type { FunctionTaskRecord } from "./function-snippets";

describe("function task details helpers", () => {
  test("getTaskLatestLogPreview returns up to maxEntries from latest_logs", () => {
    const task: FunctionTaskRecord = {
      id: "tsk_1",
      status: "dead_lettered",
      function_slug: "mockup-generator",
      attempt: 3,
      max_attempts: 3,
      error: "boom",
      updated_at: "2026-04-17T12:00:00.000Z",
      created_at: "2026-04-17T11:59:00.000Z",
      latest_logs: [
        { timestamp: "2026-04-17T12:00:00.000Z", stream: "stderr", level: "error", message: "err-1" },
        { timestamp: "2026-04-17T12:00:01.000Z", stream: "stdout", level: "info", message: "out-2" },
        { timestamp: "2026-04-17T12:00:02.000Z", stream: "stdout", level: "info", message: "out-3" },
        { timestamp: "2026-04-17T12:00:03.000Z", stream: "stderr", level: "error", message: "err-4" },
      ],
    };

    expect(getTaskLatestLogPreview(task, 2)).toEqual([
      { timestamp: "2026-04-17T12:00:00.000Z", stream: "stderr", level: "error", message: "err-1" },
      { timestamp: "2026-04-17T12:00:01.000Z", stream: "stdout", level: "info", message: "out-2" },
    ]);
  });

  test("hasTaskLogPreview reports whether latest_logs is present", () => {
    const withLogs: FunctionTaskRecord = {
      id: "tsk_1",
      status: "failed",
      function_slug: "image-render",
      attempt: 1,
      max_attempts: 1,
      error: "failed",
      updated_at: "2026-04-17T12:00:00.000Z",
      created_at: "2026-04-17T11:59:00.000Z",
      latest_logs: [{ timestamp: "2026-04-17T12:00:00.000Z", stream: "stderr", level: "error", message: "boom" }],
    };
    const withoutLogs: FunctionTaskRecord = {
      id: "tsk_2",
      status: "failed",
      function_slug: "image-render",
      attempt: 1,
      max_attempts: 1,
      error: "failed",
      updated_at: "2026-04-17T12:00:00.000Z",
      created_at: "2026-04-17T11:59:00.000Z",
    };

    expect(hasTaskLogPreview(withLogs)).toBe(true);
    expect(hasTaskLogPreview(withoutLogs)).toBe(false);
  });
});
