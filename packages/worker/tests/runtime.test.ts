import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkerTelemetry, serveWorkerHealth } from "../src/telemetry.js";
import { normalizeAccounting, type AccountingRequest } from "../src/native.js";
import { submitBoundedTask } from "../src/bounded-admission.js";
import { LocalArtifacts } from "../examples/reporting/report.js";
import { runtimeAcceptance, nativeProtocolAcceptance } from "./fixtures/runtime-acceptance.js";

test("task stage metrics are bounded and never include input or errors", async () => {
  const telemetry = createWorkerTelemetry();
  const handler = telemetry.wrap({
    decode: (v: unknown) => v, authorize: () => true,
    async execute() { throw new Error("secret-must-not-leak"); },
  });
  const context = {
    projectRef: "fixture", queueName: "scw_reports", taskKey: "report.generate",
    idempotencyKey: "op", messageId: "1", attempt: 1, signal: new AbortController().signal,
  };
  handler.decode({ password: "secret" });
  await handler.authorize({}, context);
  await expect(handler.execute({}, context)).rejects.toThrow();
  expect(telemetry.snapshot().failed).toBe(1);
  expect(telemetry.snapshot().active).toBe(0);
  expect(telemetry.prometheus()).toContain('scw_stage_errors_total{stage="execute"} 1');
  expect(telemetry.prometheus()).not.toContain("secret");
});

test("readiness fails closed on probe failure, stale probes, and stopping", async () => {
  let state = "running";
  let fail = false;
  let hang = false;
  let finish: (() => void) | undefined;
  const health = serveWorkerHealth({
    port: 0, pollMs: 10, state: () => state, telemetry: createWorkerTelemetry(),
    maxQueueAgeSeconds: 2, maxActiveMs: 100,
    async probe() {
      if (fail) throw new Error("private database URL");
      if (hang) await new Promise<void>(resolve => { finish = resolve; });
      return { pending: 1, oldestAgeSeconds: 1 };
    },
  });
  const read = (path = "/ready") => fetch(`http://127.0.0.1:${health.port}${path}`);
  try {
    await Bun.sleep(15);
    expect((await read()).status).toBe(200);
    fail = true;
    await Bun.sleep(25);
    expect((await read()).status).toBe(503);
    expect(await (await read()).text()).not.toContain("private");
    fail = false; hang = true;
    await Bun.sleep(50);
    expect((await read()).status).toBe(503);
    expect((await read("/live")).status).toBe(200);
    hang = false; finish?.();
    await Bun.sleep(25);
    state = "stopping";
    expect((await read()).status).toBe(503);
  } finally { finish?.(); health.stop(); }
});

test("local artifact publication is immutable and content checked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scw-artifact-"));
  try {
    const artifacts = new LocalArtifacts(directory);
    const [first, second] = await Promise.all([artifacts.put("report\n"), artifacts.put("report\n")]);
    expect(first).toBe(second);
    expect((await artifacts.read(first)).toString()).toBe("report\n");
    await Bun.write(join(directory, first), "tampered");
    await expect(artifacts.read(first)).rejects.toThrow("ARTIFACT_CORRUPT");
    await expect(artifacts.read("../secret")).rejects.toThrow("ARTIFACT_INVALID");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("bounded admission preserves prepare errors while redacting enqueue failures", async () => {
  const businessError = new Error("REPORT_FORBIDDEN");
  type FakeTransaction = (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<unknown[]>;
  const sql = {
    async begin(
      _options: string,
      callback: (transaction: FakeTransaction) => Promise<unknown>,
    ) {
      const transaction = async () => [];
      return callback(transaction);
    },
  } as unknown as SQL;
  await expect(submitBoundedTask(sql, {
    projectRef: "fixture", queueName: "scw_reports", taskKey: "report.generate",
  }, async () => {
    throw businessError;
  })).rejects.toBe(businessError);

  let queryCount = 0;
  const failingSql = {
    async begin(
      _options: string,
      callback: (transaction: FakeTransaction) => Promise<unknown>,
    ) {
      const transaction: FakeTransaction = async () => {
        queryCount++;
        if (queryCount === 3) throw new Error("WORKER_QUEUE_FULL");
        return [];
      };
      return callback(transaction);
    },
  } as unknown as SQL;
  await expect(submitBoundedTask(failingSql, {
    projectRef: "fixture", queueName: "scw_reports", taskKey: "report.generate",
  }, async () => ({
    replay: false, value: "operation", idempotencyKey: "operation", input: {},
  }))).rejects.toMatchObject({ code: "WORKER_QUEUE_FULL" });
});

describe("optional native computation client", () => {
  const request: AccountingRequest = {
    schemaVersion: 1, projectRef: "fixture", operationId: "operation:1",
    records: [{
      sessionId: "session-1", sequence: "1", kind: "interim",
      inputOctets: "18446744073709551615", outputOctets: "9007199254740993",
      recordedAt: "2026-10-04T00:00:00Z",
    }],
  };
  test("rejects mismatched results, oversized responses and timeouts", async () => {
    let mode = "ok";
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
      if (mode === "large") return new Response("x".repeat(1024 * 1024 + 1));
      if (mode === "slow") await Bun.sleep(100);
      return Response.json({ ...request, projectRef: mode === "scope" ? "other" : request.projectRef });
    } });
    try {
      const run = () => normalizeAccounting(`http://127.0.0.1:${server.port}`, "x".repeat(32), request,
        { signal: new AbortController().signal, timeoutMs: 20 });
      expect((await run()).records[0]?.inputOctets).toBe("18446744073709551615");
      for (mode of ["scope", "large", "slow"]) await expect(run()).rejects.toThrow("NATIVE_EXECUTION_FAILED");
    } finally { server.stop(true); }
  });
});

test.skipIf(process.env.SCW_RUNTIME_ACCEPTANCE !== "1")(
  "disposable PostgreSQL, bounded Docker worker, recovery, and mixed-load acceptance",
  runtimeAcceptance, 240000,
);

test.skipIf(process.env.SCW_NATIVE_ACCEPTANCE !== "1")(
  "built Go service interoperates with TypeScript client and drains on SIGTERM",
  nativeProtocolAcceptance, 60000,
);
