import { afterEach, expect, test } from "bun:test";
import { taskAttemptTrace, parseTaskTraceparent } from "../../src/utils/task-trace";
import { beginRequestObservability } from "../../src/utils/observability";
import { recordBackgroundObservation, renderBackgroundMetrics, resetBackgroundMetricsForTests } from "../../src/utils/background-observability";
import { parseBackgroundInvocation } from "../../src/utils/background-invocation";

afterEach(resetBackgroundMetricsForTests);
test("persisted queue trace survives retry with separate attempt spans", () => {
  const request = new Request("http://localhost/functions/v1/job", {
    headers: { traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01" },
  });
  const trace = beginRequestObservability(request);
  const serialized: unknown = JSON.parse(JSON.stringify({
    trace: { project_ref: "tenant_a", traceparent: trace.traceparent, request_id: trace.requestId },
  }));
  const task = {
    id: "task_1", project_ref: "tenant_a", trace_id: trace.traceId,
    payload: parseBackgroundInvocation(serialized),
  };
  const first = parseTaskTraceparent(taskAttemptTrace(task).get("traceparent"));
  const retry = parseTaskTraceparent(taskAttemptTrace(task).get("traceparent"));
  if (!first || !retry) throw new Error("Expected valid attempt trace headers");
  expect(first.traceId).toBe(trace.traceId);
  expect(retry.traceId).toBe(first.traceId);
  expect(retry.spanId).not.toBe(first.spanId);
  expect(() => taskAttemptTrace({ ...task, project_ref: "tenant_b" })).toThrow("inconsistent");
  expect(() => taskAttemptTrace({ ...task, trace_id: "f".repeat(32) })).toThrow("inconsistent");
});

test("malformed trace identities are rejected rather than replaced with a legacy trace", () => {
  for (const trace of [null, [], "invalid", {}, {
    project_ref: "tenant_a",
    traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    request_id: "invalid\nheader",
  }]) {
    expect(() => taskAttemptTrace({
      id: "task_1", project_ref: "tenant_a",
      trace_id: "0123456789abcdef0123456789abcdef", payload: { trace },
    })).toThrow("inconsistent");
  }
  for (const value of [null, {}, "", "00-" + "0".repeat(32) + "-0123456789abcdef-01"]) {
    expect(parseTaskTraceparent(value)).toBeNull();
  }
});

test("legacy traces are stable and tenant scoped, not copied from client headers", () => {
  const task = { id: "task_1", project_ref: "tenant_a", trace_id: "old-uuid",
    payload: { headers: { traceparent: "malicious", baggage: "private" } } };
  const first = taskAttemptTrace(task).get("x-supacloud-trace-id");
  expect(taskAttemptTrace(task).get("x-supacloud-trace-id")).toBe(first);
  expect(taskAttemptTrace({ ...task, project_ref: "tenant_b" }).get("x-supacloud-trace-id")).not.toBe(first);
});

test("background SLO counters are cumulative and independent of trace sampling", () => {
  for (let index = 0; index < 10_001; index++) recordBackgroundObservation(2, false);
  recordBackgroundObservation(5000, true);
  const metrics = renderBackgroundMetrics();
  expect(metrics).toContain("supacloud_background_attempts_total 10002");
  expect(metrics).toContain("supacloud_background_failures_total 1");
  expect(metrics).toContain('supacloud_background_queue_wait_seconds_bucket{le="5"} 10001');
  expect(metrics).toContain("supacloud_background_queue_wait_seconds_sum 25002");
});
