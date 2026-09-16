import { mock } from "bun:test";
import assert from "node:assert/strict";
import type { EdgeWorker } from "@pgflow/edge-worker";
import { Flow } from "@pgflow/dsl";

const mode = process.argv[2];
let starts = 0;
let stops = 0;
let received: unknown;
const handle = {
  async stopWorker() {
    stops++;
  },
};

// Separate processes keep the upstream singleton and module mock out of other tests.
mock.module("@pgflow/edge-worker", () => ({
  EdgeWorker: {
    async startQueueWorker(handler, config) {
      assert.equal(typeof handler, "function");
      starts++;
      received = config;
      return handle;
    },
    async startFlowWorker(flow, config) {
      assert.equal(flow.slug, "scw_report_v1");
      starts++;
      received = config;
      return handle;
    },
  } satisfies {
    startQueueWorker: (
      ...args: Parameters<typeof EdgeWorker.startQueueWorker>
    ) => Promise<typeof handle>;
    startFlowWorker: (
      ...args: Parameters<typeof EdgeWorker.startFlowWorker>
    ) => Promise<typeof handle>;
  },
}));

const { createPgflowQueueWorker, createPgflowWorker } = await import(
  "../../src/index.js"
);
const options = {
  projectRef: "project-a",
  connectionString: "postgresql://worker:placeholder@localhost/project_a",
  concurrency: 3,
};
const worker =
  mode === "flow"
    ? createPgflowWorker(
        new Flow<{ fileId: string }>({ slug: "scw_report_v1" }).step(
          { slug: "extract" },
          (input) => input.fileId,
        ),
        options,
      )
    : createPgflowQueueWorker(
        { ...options, queueName: "scw_reports", taskKey: "report.generate" },
        {
          decode: (input: unknown) => input,
          authorize: () => true,
          execute() {},
        },
      );
assert.equal(starts, 0);
if (mode === "wrong-project" || mode === "edge-runtime") {
  if (mode === "wrong-project") process.env.SUPACLOUD_PROJECT_REF = "project-b";
  else Reflect.set(globalThis, "EdgeRuntime", {});
  await assert.rejects(worker.start(), /WORKER_START_FAILED/);
  assert.equal(starts, 0);
} else {
  await Promise.all([worker.start(), worker.start()]);
  assert.equal(starts, 1);
  const common = {
    ...options,
    maxConcurrent: 3,
    batchSize: 3,
    maxPgConnections: 4,
    maxPollSeconds: 2,
    pollIntervalMs: 200,
  };
  const {
    projectRef: _project,
    concurrency: _concurrency,
    ...expected
  } = common;
  assert.deepEqual(
    received,
    mode === "flow"
      ? expected
      : {
          ...expected,
          queueName: "scw_reports",
          visibilityTimeout: 300,
          retry: {
            strategy: "exponential",
            limit: 5,
            baseDelay: 5,
            maxDelay: 300,
          },
        },
  );
  const other = createPgflowQueueWorker(
    {
      ...options,
      queueName: "scw_other",
      taskKey: "other",
    },
    { decode: (value: unknown) => value, authorize: () => true, execute() {} },
  );
  await assert.rejects(other.start(), /WORKER_START_FAILED/);
  assert.equal(starts, 1);
  await Promise.all([worker.stop(), worker.stop()]);
  assert.equal(stops, 1);
  assert.equal(worker.state, "stopped");
}
