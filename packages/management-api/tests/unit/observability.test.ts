import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  applyObservabilityHeaders,
  beginRequestObservability,
  recordRequestObservation,
  renderRequestMetrics,
  resetRequestMetricsForTests,
} from "../../src/utils/observability";

afterEach(() => {
  mock.restore();
  resetRequestMetricsForTests();
});

const durationMetric = "supacloud_management_http_request_duration_ms";
const bucketLimits = [10, 50, 100, 250, 500, 1000, 5000];

function metricValue(metrics: string, name: string): number {
  const line = metrics.split("\n").find((line) => line.startsWith(`${name} `));
  if (!line) throw new Error(`Missing metric: ${name}`);
  return Number(line.slice(name.length + 1));
}

function observeDuration(durationMs: number, status = 200): void {
  const request = new Request("http://localhost/health");
  beginRequestObservability(request).startedAt = performance.now() - durationMs;
  recordRequestObservation(request, status);
}

describe("request observability", () => {
  test("preserves a valid inbound request and trace identity", () => {
    const request = new Request("http://localhost/health", {
      headers: {
        "x-request-id": "req-123",
        "x-supacloud-correlation-id": "workflow-123",
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      },
    });
    const context = beginRequestObservability(request);
    const headers: Record<string, string | number> = {};

    applyObservabilityHeaders(headers, context);

    expect(context.requestId).toBe("req-123");
    expect(context.traceId).toBe("0123456789abcdef0123456789abcdef");
    expect(context.correlationId).toBe("workflow-123");
    expect(headers).toEqual({
      "x-request-id": "req-123",
      "x-supacloud-trace-id": "0123456789abcdef0123456789abcdef",
      "x-supacloud-correlation-id": "workflow-123",
    });
  });

  test("rejects unsafe inbound identifiers and records Prometheus metrics", () => {
    const request = new Request("http://localhost/failure", {
      headers: {
        "x-request-id": "bad value",
        "x-supacloud-trace-id": "not-a-trace",
      },
    });
    const context = beginRequestObservability(request);
    recordRequestObservation(request, 503);
    const metrics = renderRequestMetrics();

    expect(context.requestId).not.toBe("bad value");
    expect(context.traceId).not.toBe("not-a-trace");
    expect(metrics).toContain("supacloud_management_http_requests_total 1");
    expect(metrics).toContain("supacloud_management_http_errors_total 1");
    expect(metrics).toContain('supacloud_management_http_responses_total{status="503"} 1');
  });

  test("exposes a complete empty histogram before the first observation", () => {
    const metrics = renderRequestMetrics();

    expect(metrics).toContain(`# HELP ${durationMetric} Management API request duration in milliseconds.`);
    expect(metrics).toContain(`# TYPE ${durationMetric} histogram`);
    for (const bucket of [...bucketLimits, "+Inf"]) {
      expect(metricValue(metrics, `${durationMetric}_bucket{le="${bucket}"}`)).toBe(0);
    }
    expect(metricValue(metrics, `${durationMetric}_sum`)).toBe(0);
    expect(metricValue(metrics, `${durationMetric}_count`)).toBe(0);
  });

  test("records inclusive cumulative buckets, sum and count for all responses", () => {
    spyOn(performance, "now").mockReturnValue(100_000);
    const durations = [0, 0.5, ...bucketLimits, 5000.5, 10_000];
    for (const [index, duration] of durations.entries()) {
      observeDuration(duration, index === durations.length - 1 ? 503 : 200);
    }

    const metrics = renderRequestMetrics();
    for (const bucket of bucketLimits) {
      expect(metricValue(metrics, `${durationMetric}_bucket{le="${bucket}"}`))
        .toBe(durations.filter((duration) => duration <= bucket).length);
    }
    expect(metricValue(metrics, `${durationMetric}_bucket{le="+Inf"}`)).toBe(durations.length);
    expect(metricValue(metrics, `${durationMetric}_count`)).toBe(durations.length);
    expect(metricValue(metrics, `${durationMetric}_sum`))
      .toBe(durations.reduce((sum, duration) => sum + duration, 0));
    expect(metricValue(metrics, "supacloud_management_http_requests_total")).toBe(durations.length);
    expect(metricValue(metrics, "supacloud_management_http_errors_total")).toBe(1);
    expect(metricValue(metrics, 'supacloud_management_http_responses_total{status="200"}'))
      .toBe(durations.length - 1);
    expect(metricValue(metrics, 'supacloud_management_http_responses_total{status="503"}')).toBe(1);
    expect(renderRequestMetrics()).toBe(metrics);
  });

  test("never evicts histogram observations after ten thousand requests", () => {
    spyOn(performance, "now").mockReturnValue(100_000);
    for (let index = 0; index < 10_000; index++) observeDuration(1);
    const before = renderRequestMetrics();

    observeDuration(10_000, 503);
    const after = renderRequestMetrics();

    for (const bucket of bucketLimits) {
      const name = `${durationMetric}_bucket{le="${bucket}"}`;
      expect(metricValue(before, name)).toBe(10_000);
      expect(metricValue(after, name)).toBe(10_000);
    }
    expect(metricValue(after, `${durationMetric}_bucket{le="+Inf"}`)).toBe(10_001);
    expect(metricValue(after, `${durationMetric}_count`)).toBe(10_001);
    expect(metricValue(after, `${durationMetric}_sum`)).toBe(20_000);
    expect(metricValue(after, "supacloud_management_http_requests_total")).toBe(10_001);
  });

  test("reset clears every accumulator and subsequent observations start from zero", () => {
    spyOn(performance, "now").mockReturnValue(100_000);
    const emptyMetrics = renderRequestMetrics();
    observeDuration(5000, 503);

    resetRequestMetricsForTests();

    expect(renderRequestMetrics()).toBe(emptyMetrics);
    observeDuration(5);
    const metrics = renderRequestMetrics();
    for (const bucket of [...bucketLimits, "+Inf"]) {
      expect(metricValue(metrics, `${durationMetric}_bucket{le="${bucket}"}`)).toBe(1);
    }
    expect(metricValue(metrics, `${durationMetric}_sum`)).toBe(5);
    expect(metricValue(metrics, `${durationMetric}_count`)).toBe(1);
    expect(metricValue(metrics, "supacloud_management_http_errors_total")).toBe(0);
    expect(metrics).not.toContain('status="503"');
  });
});
