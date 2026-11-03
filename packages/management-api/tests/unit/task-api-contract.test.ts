import { describe, expect, test } from "bun:test";
import { Value } from "typebox/value";
import { taskApi } from "../../src/contracts/task-api";

const date = new Date("2026-01-01T00:00:00.000Z");
const task = {
  id: "task-1", project_ref: "project-1", task_type: "provision_db", status: "succeeded",
  payload: {}, result: {}, error: null, retries: 0, attempt: 1, max_attempts: 3,
  next_run_at: null, lease_until: null, started_at: date, completed_at: date,
  timeout_sec: null, idempotency_key: null, trace_id: null, cancel_requested_at: null,
  cancellation_reason: null, correlation_id: null, business_task_id: null,
  invoker_user_id: null, auth_authority_ref: "management", metadata: null,
  function_slug: null, function_version: null, created_at: date, updated_at: date,
};

describe("task API contracts", () => {
  test("accept the repository row shape and reject invalid rows", () => {
    expect(Value.Check(taskApi.listResponse, [task])).toBe(true);
    expect(Value.Check(taskApi.listResponse, [{ ...task, status: "unknown" }])).toBe(false);
    expect(Value.Check(taskApi.listResponse, [{ ...task, project_ref: undefined }])).toBe(false);
  });

  test("keep detail and statistics contracts runtime-checkable", () => {
    expect(Value.Check(taskApi.detailResponse, { ...task, attempts: [], latest_logs: [] })).toBe(true);
    expect(Value.Check(taskApi.statsResponse, {
      running: 1, retryScheduled: 0, deadLettered: 0, failedLast24h: 0,
      cancelledLast24h: 0, topFailures: [], failedTrend: [],
    })).toBe(true);
    expect(Value.Check(taskApi.statsResponse, { running: -1 })).toBe(false);
  });
});
