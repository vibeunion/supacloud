import { mock } from "bun:test";
import assert from "node:assert/strict";
import type { EdgeWorker } from "@pgflow/edge-worker";
import { Flow } from "@pgflow/dsl";

let received: unknown;
let stops = 0;
mock.module("@pgflow/edge-worker", () => ({
  EdgeWorker: {
    async startQueueWorker(_handler, options) {
      received = options;
      return { async stopWorker() { stops++; } };
    },
  } satisfies {
    startQueueWorker: (
      ...args: Parameters<typeof EdgeWorker.startQueueWorker>
    ) => Promise<{ stopWorker(): Promise<void> }>;
  },
}));
const { startQueueWorkerFromEnvironment } = await import("../../src/delivery.js");
const { createPgflowWorker } = await import("../../src/index.js");
// Upstream reads real process credentials, not an arbitrary configuration object.
await assert.rejects(createPgflowWorker(
  new Flow<{ id: string }>({ slug: "scw_delivery_check" }).step({ slug: "read" }, input => input.id),
  {
    projectRef: "project-a", connectionString: process.env.EDGE_WORKER_DB_URL!,
    environment: { ...process.env, SUPABASE_URL: "http://different-project.invalid" },
  },
).start(), /WORKER_START_FAILED/);
await assert.rejects(startQueueWorkerFromEnvironment({
  decode: (input: unknown) => input, authorize: () => true, execute() {},
}, { ...process.env, SUPABASE_URL: "http://different-project.invalid" }), /WORKER_START_FAILED/);
assert.equal(received, undefined);
const worker = await startQueueWorkerFromEnvironment({
  decode: (input: unknown) => input,
  authorize: () => true,
  execute() {},
});
assert.equal(worker.state, "running");
assert.deepEqual(received, {
  connectionString: "postgresql://worker:fixture@localhost/project_a",
  maxConcurrent: 2,
  batchSize: 2,
  maxPgConnections: 3,
  maxPollSeconds: 2,
  pollIntervalMs: 200,
  queueName: "scw_reports",
  visibilityTimeout: 60,
  retry: { strategy: "exponential", limit: 1, baseDelay: 5, maxDelay: 300 },
});
await worker.stop();
assert.equal(worker.state, "stopped");
assert.equal(stops, 1);
