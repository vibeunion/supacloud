import { Elysia, StatusMap } from "elysia";

const requestIds = new WeakMap<Request, string>();

export function httpRequestId(request: Request): string | undefined {
  return requestIds.get(request);
}

export interface HttpTelemetryEvent {
  requestId: string;
  method: string;
  /** Static route template only. Query strings and concrete paths are excluded. */
  route: string;
  status: number;
  durationMs: number;
}

export type HttpTelemetryObserver = (event: Readonly<HttpTelemetryEvent>) => void | Promise<void>;

/** Request tracing is best effort, not a durable business audit. */
export function createHttpTelemetry(observe: HttpTelemetryObserver) {
  const starts = new WeakMap<Request, { time: number; requestId: string }>();
  return new Elysia()
    .onRequest(({ request, set }) => {
      const supplied = request.headers.get("x-request-id");
      const requestId = supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : crypto.randomUUID();
      starts.set(request, { time: performance.now(), requestId });
      requestIds.set(request, requestId);
      set.headers["x-request-id"] = requestId;
    })
    // Elysia's fast 404 path skips afterResponse without a registered error hook.
    .onError(() => undefined)
    .onAfterResponse(async ({ request, response, set, route }) => {
      const start = starts.get(request);
      if (!start) return;
      starts.delete(request);
      const status = response instanceof Response ? response.status
        : typeof set.status === "number" ? set.status : StatusMap[set.status ?? "OK"];
      try {
        await observe(Object.freeze({
          requestId: start.requestId, method: request.method,
          route: route ?? "<unmatched>", status, durationMs: performance.now() - start.time,
        }));
      } catch {
        // Observability outages cannot change a completed response or command outcome.
      }
    }).as("global");
}
