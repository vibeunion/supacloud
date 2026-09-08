import { randomBytes } from "node:crypto";
import { parseTaskTraceparent } from "./task-trace";
import { renderBackgroundMetrics } from "./background-observability";

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const SLOW_REQUEST_MS = 1000;
const latencyBuckets = [10, 50, 100, 250, 500, 1000, 5000];
const durationMetric = "supacloud_management_http_request_duration_ms";

export interface RequestObservabilityContext {
  requestId: string;
  traceId: string;
  correlationId: string;
  startedAt: number;
  traceparent: string;
  parentSpanId: string | null;
}

interface RequestMetricState {
  requests: number;
  errors: number;
  durationBuckets: number[];
  durationSum: number;
  status: Map<number, number>;
}

const requestContexts = new WeakMap<Request, RequestObservabilityContext>();
const observations = new WeakMap<Request, { context: RequestObservabilityContext; durationMs: number; slow: boolean }>();
const metricState: RequestMetricState = {
  requests: 0,
  errors: 0,
  durationBuckets: latencyBuckets.map(() => 0),
  durationSum: 0,
  status: new Map(),
};

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function validRequestId(value: string | null): string | undefined {
  if (!value || !REQUEST_ID_PATTERN.test(value)) return undefined;
  return value;
}

function traceIdFromTraceparent(value: string | null): string | undefined {
  return parseTaskTraceparent(value)?.traceId;
}

export function beginRequestObservability(request: Request): RequestObservabilityContext {
  const existing = requestContexts.get(request);
  if (existing) return existing;

  const requestId = validRequestId(request.headers.get("x-request-id"))
    ?? validRequestId(request.headers.get("x-sb-execution-id"))
    ?? randomHex(16);
  const suppliedTraceId = request.headers.get("x-supacloud-trace-id");
  const traceId = traceIdFromTraceparent(request.headers.get("traceparent"))
    ?? (suppliedTraceId && TRACE_ID_PATTERN.test(suppliedTraceId) && !/^0+$/.test(suppliedTraceId) ? suppliedTraceId : randomHex(16));
  const correlationId = validRequestId(request.headers.get("x-supacloud-correlation-id"))
    ?? requestId;

  const parent = parseTaskTraceparent(request.headers.get("traceparent"));
  const rate = Number(process.env.SUPACLOUD_TRACE_SAMPLE_RATE ?? "0.1");
  const sampled = Number.isFinite(rate) && rate >= 0 && rate <= 1
    && parseInt(traceId.slice(0, 8), 16) / 0x1_0000_0000 < rate
    && (parent ? parent.flags === "01" : true);
  const traceparent = `00-${traceId}-${randomHex(8)}-${sampled ? "01" : "00"}`;
  const context = { requestId, traceId, correlationId, traceparent, parentSpanId: parent?.spanId ?? null, startedAt: performance.now() };
  requestContexts.set(request, context);
  return context;
}

export function applyObservabilityHeaders(
  headers: Record<string, string | number>,
  context: RequestObservabilityContext,
): void {
  headers["x-request-id"] ??= context.requestId;
  headers["x-supacloud-trace-id"] ??= context.traceId;
  headers["x-supacloud-correlation-id"] ??= context.correlationId;
  headers.traceparent ??= context.traceparent;
}

export function recordRequestObservation(
  request: Request,
  status: number,
): { context: RequestObservabilityContext; durationMs: number; slow: boolean } {
  const existing = observations.get(request);
  if (existing) return existing;
  const context = beginRequestObservability(request);
  const durationMs = Math.max(0, performance.now() - context.startedAt);
  metricState.requests += 1;
  if (status >= 500) metricState.errors += 1;
  metricState.status.set(status, (metricState.status.get(status) ?? 0) + 1);
  metricState.durationSum += durationMs;
  for (const [index, bucket] of latencyBuckets.entries()) {
    if (durationMs <= bucket) metricState.durationBuckets[index]! += 1;
  }
  const observation = { context, durationMs, slow: durationMs >= SLOW_REQUEST_MS };
  observations.set(request, observation);
  const trace = parseTaskTraceparent(context.traceparent)!;
  if (trace.flags === "01") console.info(JSON.stringify({
    schema: "supacloud.trace-span.v1", operation: "management.request",
    traceId: context.traceId, spanId: trace.spanId, parentSpanId: context.parentSpanId,
    requestId: context.requestId, durationMs, status,
  }));
  return observation;
}

export function renderRequestMetrics(): string {
  const lines = [
    "# HELP supacloud_management_http_requests_total Total Management API requests.",
    "# TYPE supacloud_management_http_requests_total counter",
    `supacloud_management_http_requests_total ${metricState.requests}`,
    "# HELP supacloud_management_http_errors_total Total Management API 5xx responses.",
    "# TYPE supacloud_management_http_errors_total counter",
    `supacloud_management_http_errors_total ${metricState.errors}`,
  ];
  for (const [status, count] of metricState.status) {
    lines.push(`supacloud_management_http_responses_total{status="${status}"} ${count}`);
  }
  lines.push(
    `# HELP ${durationMetric} Management API request duration in milliseconds.`,
    `# TYPE ${durationMetric} histogram`,
  );
  for (const [index, bucket] of latencyBuckets.entries()) {
    lines.push(
      `${durationMetric}_bucket{le="${bucket}"} ${metricState.durationBuckets[index]}`,
    );
  }
  lines.push(
    `${durationMetric}_bucket{le="+Inf"} ${metricState.requests}`,
    `${durationMetric}_sum ${metricState.durationSum}`,
    `${durationMetric}_count ${metricState.requests}`,
  );
  return `${lines.join("\n")}\n${renderBackgroundMetrics()}`;
}

export function resetRequestMetricsForTests(): void {
  metricState.requests = 0;
  metricState.errors = 0;
  metricState.durationBuckets.fill(0);
  metricState.durationSum = 0;
  metricState.status.clear();
}
