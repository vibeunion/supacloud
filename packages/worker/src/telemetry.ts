import type { TaskHandler } from "./queue-handler.js";

export type WorkerStage = "decode" | "authorize" | "execute" | "read" | "compute" | "write" | "external";
const stages: readonly WorkerStage[] = ["decode", "authorize", "execute", "read", "compute", "write", "external"];
const bounds = [1, 5, 25, 100, 500, 1000, 5000, 30000];

export function createWorkerTelemetry() {
  const timings = new Map(stages.map(stage => [stage, {
    count: 0, sumMs: 0, errors: 0, buckets: bounds.map(() => 0),
  }]));
  const active = new Map<symbol, number>();
  let completed = 0;
  let failed = 0;
  const record = (stage: WorkerStage, start: number, success: boolean) => {
    const timing = timings.get(stage)!;
    const ms = Math.max(0, performance.now() - start);
    timing.count++;
    timing.sumMs += ms;
    if (!success) timing.errors++;
    bounds.forEach((bound, i) => { if (ms <= bound) timing.buckets[i]!++; });
  };
  async function measure<T>(stage: WorkerStage, operation: () => T | Promise<T>): Promise<T> {
    const start = performance.now();
    try { const result = await operation(); record(stage, start, true); return result; }
    catch (error) { record(stage, start, false); throw error; }
  }
  return {
    measure,
    snapshot() {
      return {
        active: active.size, completed, failed,
        oldestActiveMs: active.size === 0 ? 0 : performance.now() - Math.min(...active.values()),
      };
    },
    wrap<T>(handler: TaskHandler<T>): TaskHandler<T> {
      return {
        decode(input) {
          const start = performance.now();
          try { const result = handler.decode(input); record("decode", start, true); return result; }
          catch (error) { record("decode", start, false); throw error; }
        },
        async authorize(input, context) {
          const id = Symbol();
          active.set(id, performance.now());
          try { return await measure("authorize", () => handler.authorize(input, context)); }
          finally { active.delete(id); }
        },
        async execute(input, context) {
          const id = Symbol();
          active.set(id, performance.now());
          try {
            await measure("execute", () => handler.execute(input, context));
            completed++;
          } catch (error) { failed++; throw error; }
          finally { active.delete(id); }
        },
      };
    },
    prometheus() {
      const lines: string[] = [];
      for (const [stage, timing] of timings) {
        const label = `stage="${stage}"`;
        lines.push(`scw_stage_seconds_count{${label}} ${timing.count}`);
        lines.push(`scw_stage_seconds_sum{${label}} ${timing.sumMs / 1000}`);
        lines.push(`scw_stage_errors_total{${label}} ${timing.errors}`);
        bounds.forEach((bound, i) => lines.push(
          `scw_stage_seconds_bucket{${label},le="${bound / 1000}"} ${timing.buckets[i]}`,
        ));
        lines.push(`scw_stage_seconds_bucket{${label},le="+Inf"} ${timing.count}`);
      }
      lines.push(`scw_tasks_active ${active.size}`, `scw_tasks_completed_total ${completed}`,
        `scw_tasks_failed_total ${failed}`);
      return lines.join("\n") + "\n";
    },
  };
}

export interface QueueHealth { pending: number; oldestAgeSeconds: number }

export { createQueueJobMetrics, type QueueJobMetrics } from "./job-metrics.js";

/** Loopback-only operational endpoint; no task data, credentials or exception text. */
export function serveWorkerHealth(options: {
  port: number;
  state: () => string;
  telemetry: ReturnType<typeof createWorkerTelemetry>;
  probe: () => Promise<QueueHealth>;
  maxQueueAgeSeconds: number;
  maxActiveMs: number;
  pollMs?: number;
}) {
  const pollMs = options.pollMs ?? 1000;
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535 ||
    !Number.isSafeInteger(pollMs) || pollMs < 10 || !Number.isFinite(options.maxQueueAgeSeconds) ||
    options.maxQueueAgeSeconds < 0 || !Number.isFinite(options.maxActiveMs) || options.maxActiveMs <= 0)
    throw new Error("WORKER_HEALTH_CONFIG_INVALID");
  let queue: QueueHealth | undefined;
  let observedAt = 0;
  let closed = false;
  let probing = false;
  const probe = async () => {
    if (probing || closed) return;
    probing = true;
    try {
      const result = await options.probe();
      if (!Number.isSafeInteger(result.pending) || result.pending < 0 ||
        !Number.isFinite(result.oldestAgeSeconds) || result.oldestAgeSeconds < 0) throw new Error();
      queue = result;
      observedAt = performance.now();
    } catch { queue = undefined; }
    finally { probing = false; }
  };
  const timer = setInterval(() => { void probe(); }, pollMs);
  void probe();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: options.port,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method !== "GET") return new Response(null, { status: 405 });
      if (path === "/live") return new Response("alive\n");
      const ready = options.state() === "running" && queue !== undefined &&
        performance.now() - observedAt <= pollMs * 3 &&
        queue.oldestAgeSeconds <= options.maxQueueAgeSeconds &&
        options.telemetry.snapshot().oldestActiveMs <= options.maxActiveMs;
      if (path === "/ready") return Response.json({ ready }, { status: ready ? 200 : 503 });
      if (path === "/metrics") return new Response(
        options.telemetry.prometheus() + `scw_ready ${Number(ready)}\n` +
        (queue ? `scw_queue_pending ${queue.pending}\nscw_queue_oldest_age_seconds ${queue.oldestAgeSeconds}\n` : ""),
        { headers: { "content-type": "text/plain; version=0.0.4" } },
      );
      return new Response(null, { status: 404 });
    },
  });
  return { port: server.port!, stop() { closed = true; clearInterval(timer); server.stop(true); } };
}
