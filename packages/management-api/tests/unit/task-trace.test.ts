import { afterEach, expect, test } from "bun:test";
import { taskAttemptTrace, parseTaskTraceparent } from "../../src/utils/task-trace";
import { beginRequestObservability } from "../../src/utils/observability";
import { recordBackgroundObservation, renderBackgroundMetrics, resetBackgroundMetricsForTests } from "../../src/utils/background-observability";

afterEach(resetBackgroundMetricsForTests);
test("persisted queue trace survives retry with separate attempt spans", () => {
  const request = new Request("http://localhost/functions/v1/job", {
    headers: { traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01" },
  });
  const trace = beginRequestObservability(request);
  const task = JSON.parse(JSON.stringify({
    id: "task_1", project_ref: "tenant_a", trace_id: trace.traceId,
    payload: { trace: { project_ref: "tenant_a", traceparent: trace.traceparent, request_id: trace.requestId } },
  }));
  const first = parseTaskTraceparent(taskAttemptTrace(task).get("traceparent"))!;
  const retry = parseTaskTraceparent(taskAttemptTrace(task).get("traceparent"))!;
  expect(first.traceId).toBe(trace.traceId);
  expect(retry.traceId).toBe(first.traceId);
  expect(retry.spanId).not.toBe(first.spanId);
  expect(() => taskAttemptTrace({ ...task, project_ref: "tenant_b" })).toThrow("inconsistent");
  expect(() => taskAttemptTrace({ ...task, trace_id: "f".repeat(32) })).toThrow("inconsistent");
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
