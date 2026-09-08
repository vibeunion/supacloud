import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export interface FunctionTrace {
  projectRef: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  sampled: boolean;
}

export interface TraceSpan extends FunctionTrace {
  schema: "supacloud.trace-span.v1";
  operation: "function" | "http.client";
  durationMs: number;
  status: number;
}

type TraceScope = { trace: FunctionTrace; active: boolean; emitted: number };
const scopes = new AsyncLocalStorage<TraceScope>();
const hostSampleRate = traceSampleRate(process.env.SUPACLOUD_TRACE_SAMPLE_RATE);
const MAX_CLIENT_SPANS = 64;

export function traceSampleRate(value?: string): number {
  if (value === undefined) return 0.1;
  const rate = Number(value);
  return value.trim() && Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0;
}

export function parseTraceparent(value: string | null) {
  const match = value?.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/);
  if (!match || /^0+$/.test(match[1]!) || /^0+$/.test(match[2]!)) return null;
  return { traceId: match[1]!, spanId: match[2]!, sampled: (parseInt(match[3]!, 16) & 1) === 1 };
}

export function createFunctionTrace(
  projectRef: string,
  headers: Headers,
  sampleRate = hostSampleRate,
): FunctionTrace {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectRef)) throw new Error("Invalid trace project");
  const parent = parseTraceparent(headers.get("traceparent"));
  const traceId = parent?.traceId ?? randomBytes(16).toString("hex");
  const selected = Number.isFinite(sampleRate) && sampleRate >= 0 && sampleRate <= 1
    && parseInt(traceId.slice(0, 8), 16) / 0x1_0000_0000 < sampleRate;
  return Object.freeze({
    projectRef, traceId, spanId: randomBytes(8).toString("hex"),
    parentSpanId: parent?.spanId ?? null,
    sampled: selected && (parent?.sampled ?? true),
  });
}

export function traceHeaders(trace: FunctionTrace, original?: HeadersInit): Headers {
  const headers = new Headers(original);
  headers.set("traceparent", `00-${trace.traceId}-${trace.spanId}-${trace.sampled ? "01" : "00"}`);
  headers.set("x-supacloud-trace-id", trace.traceId);
  // Vendor baggage is not an approved carrier for tenant identity or secrets.
  headers.delete("tracestate");
  headers.delete("baggage");
  return headers;
}

function emitSpan(trace: FunctionTrace, operation: TraceSpan["operation"], started: number, status: number) {
  if (!trace.sampled) return;
  console.info(JSON.stringify({
    schema: "supacloud.trace-span.v1", ...trace, operation,
    durationMs: Math.max(0, performance.now() - started), status,
  } satisfies TraceSpan));
}

export async function runFunctionTrace<T>(
  trace: FunctionTrace | undefined,
  operation: () => Promise<T>,
  responseStatus: (result: T) => number = () => 200,
): Promise<T> {
  if (!trace) return operation();
  const scope: TraceScope = { trace, active: true, emitted: 0 };
  return scopes.run(scope, async () => {
    const started = performance.now();
    let status = 500;
    try {
      const result = await operation();
      status = responseStatus(result);
      return result;
    } finally {
      scope.active = false;
      emitSpan(trace, "function", started, status);
    }
  });
}

export function createTracedFetch(original: typeof fetch): typeof fetch {
  return (async (input, init) => {
    const scope = scopes.getStore();
    if (!scope?.active) return original(input, init);
    const trace: FunctionTrace = {
      ...scope.trace, parentSpanId: scope.trace.spanId, spanId: randomBytes(8).toString("hex"),
      sampled: scope.trace.sampled && scope.emitted++ < MAX_CLIENT_SPANS,
    };
    const originalHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    const headers = traceHeaders(trace, originalHeaders);
    const started = performance.now();
    let status = 500;
    try {
      const response = await original(input, { ...init, headers });
      status = response.status;
      return response;
    } finally {
      emitSpan(trace, "http.client", started, status);
    }
  }) as typeof fetch;
}

export function installFunctionTracingFetch(): void {
  globalThis.fetch = createTracedFetch(globalThis.fetch);
}
