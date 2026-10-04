import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseWorkerDelivery, renderWorkerService, startQueueWorkerFromEnvironment,
} from "../src/delivery.js";
import { evaluateWorkerPerformance } from "../src/performance.js";
import manifest from "../examples/worker-delivery.json";
import sampleEvidence from "../examples/performance-evidence.json";

function measurements() {
  return {
    evidence: {
      candidate: "fixture-not-production", hardware: "synthetic-fixture",
      workload: "fixed-report-fixture", rawArtifact: "fixture-only",
    },
    limits: {
      minWindowSeconds: 10, minRequests: 100, minRps: 10,
      maxP95Ms: 150, maxP99Ms: 200, maxP99Ratio: 2, maxErrorRate: 0,
      maxBatchSeconds: 60, maxOldestQueueAgeSeconds: 30,
    },
    baseline: { startedAtMs: 1000000, seconds: 10, latenciesMs: Array<number>(100).fill(50), errors: 0 },
    mixed: { startedAtMs: 1020000, seconds: 10, latenciesMs: Array<number>(100).fill(80), errors: 0 },
    batch: { startedAtMs: 1020000, expected: 20, completed: 20, seconds: 30, peakOldestQueueAgeSeconds: 10 },
  };
}

describe("worker resource delivery", () => {
  test("renders bounded dedicated process without taking over the task engine", () => {
    const plan = parseWorkerDelivery(manifest);
    expect(Object.isFrozen(plan)).toBe(true);
    const unit = renderWorkerService(manifest);
    for (const setting of [
      "Type=exec", "User=scw-project-a", "CPUQuota=100%", "MemoryMax=512M",
      "MemorySwapMax=0", "TasksMax=64", "TimeoutStopSec=30", "KillMode=control-group",
      "Restart=on-failure", "ProtectSystem=strict", "NoNewPrivileges=yes",
      "EnvironmentFile=/etc/scw/project-a.env",
      "SUPACLOUD_WORKER_CONCURRENCY=4", "SUPACLOUD_WORKER_PG_CONNECTIONS=4",
      "SUPACLOUD_PROJECT_REF=project-a",
      "/usr/local/bin/bun --no-env-file /opt/scw/project-a/releases/candidate-001/worker.ts",
    ]) expect(unit).toContain(setting);
    expect(unit).not.toContain("postgresql://");
    expect(unit).not.toContain("SERVICE_ROLE_KEY=");
    expect(unit).not.toContain("/bin/sh");
  });

  test("rejects incomplete, privileged, unsafe and unbounded manifests", () => {
    for (const patch of [
      { user: "root" }, { maxPgConnections: 0 }, { concurrency: 33 },
      { memoryMaxMiB: 0 }, { cpuQuotaPercent: Number.NaN },
      { tasksMax: 1.5 }, { retryLimit: 11 }, { stopTimeoutSeconds: 0 },
      { visibilityTimeoutSeconds: 3601 }, { queueName: "platform_queue" },
      { environmentFile: "/etc/%n.env" }, { entrypoint: "/tmp/worker.ts" },
      { releaseDirectory: "/opt/../etc" }, { runtimePath: "/bin/bun\nUser=root" },
      { environmentFile: "/etc/$SECRET" }, { runtimePath: "/bin/bun --eval" },
      { runtimePath: "/bin/bun\n" }, { user: "worker\n" },
      { projectRef: "project-a\nRestart=no" }, { connectionString: "secret" },
      { artifactDirectory: "/etc" }, { artifactDirectory: "/var/lib/scw/other" },
    ]) expect(() => parseWorkerDelivery({ ...manifest, ...patch })).toThrow("WORKER_DELIVERY_INVALID");
    expect(() => parseWorkerDelivery({})).toThrow();
    expect(() => parseWorkerDelivery(null)).toThrow();
    expect(() => parseWorkerDelivery([])).toThrow();
  });

  test("a local artifact recipe grants write access only to its project directory", () => {
    const unit = renderWorkerService({ ...manifest, artifactDirectory: "/var/lib/scw/project-a/artifacts" });
    expect(unit).toContain("ReadWritePaths=/var/lib/scw/project-a/artifacts");
    expect(unit).toContain("SCW_ARTIFACT_DIRECTORY=/var/lib/scw/project-a/artifacts");
    expect(unit).toContain("ProtectSystem=strict");
  });

  test("missing or malformed runtime limits fail before connecting", async () => {
    const handler = { decode: (v: unknown) => v, authorize: () => true, execute() {} };
    const env = {
      SUPACLOUD_PROJECT_REF: "project-a",
      SUPACLOUD_WORKER_QUEUE: "scw_reports",
      SUPACLOUD_WORKER_TASK: "report.generate",
      EDGE_WORKER_DB_URL: "postgresql://worker:fixture@localhost/project_a",
      SUPACLOUD_WORKER_CONCURRENCY: "4",
      SUPACLOUD_WORKER_PG_CONNECTIONS: "4",
      SUPACLOUD_WORKER_VISIBILITY_SECONDS: "300",
      SUPACLOUD_WORKER_RETRY_LIMIT: "5",
    };
    for (const value of [undefined, "", "0", "33", "4e0", " 4", "1.5", "Infinity"]) {
      await expect(startQueueWorkerFromEnvironment(handler, {
        ...env, SUPACLOUD_WORKER_CONCURRENCY: value,
      })).rejects.toThrow("WORKER_DELIVERY_INVALID");
    }
  });

  test("runtime forwards profile limits to pgflow in a dedicated process", () => {
    const child = Bun.spawnSync([
      process.execPath, "--no-env-file",
      new URL("./fixtures/delivery-delegate.ts", import.meta.url).pathname,
    ], {
      env: {
        PATH: process.env.PATH,
        SUPACLOUD_PROJECT_REF: "project-a",
        SUPACLOUD_WORKER_QUEUE: "scw_reports",
        SUPACLOUD_WORKER_TASK: "report.generate",
        EDGE_WORKER_DB_URL: "postgresql://worker:fixture@localhost/project_a",
        SUPABASE_URL: "http://localhost:54321",
        SUPABASE_SERVICE_ROLE_KEY: "nonprivileged-fixture",
        SUPACLOUD_WORKER_CONCURRENCY: "2",
        SUPACLOUD_WORKER_PG_CONNECTIONS: "3",
        SUPACLOUD_WORKER_VISIBILITY_SECONDS: "60",
        SUPACLOUD_WORKER_RETRY_LIMIT: "1",
      },
    });
    expect(new TextDecoder().decode(child.stderr)).toBe("");
    expect(child.exitCode).toBe(0);
  });
});

describe("mixed workload acceptance gate", () => {
  test("the shipped synthetic example cannot be mistaken for passing evidence", () => {
    const result = evaluateWorkerPerformance(sampleEvidence);
    expect(result.passed).toBe(false);
    expect(result.failures).toContain("BASELINE_INSUFFICIENT_SAMPLES");
    expect(result.failures).toContain("MIXED_INSUFFICIENT_SAMPLES");
  });

  test("calculates nearest-rank percentiles without mutating evidence", () => {
    const input = measurements();
    input.mixed.latenciesMs = Array.from({ length: 100 }, (_, i) => 100 - i);
    const result = evaluateWorkerPerformance(input);
    expect(result.passed).toBe(true);
    expect(result.mixed.p95Ms).toBe(95);
    expect(result.mixed.p99Ms).toBe(99);
    expect(result.mixed.rps).toBe(10);
    expect(input.mixed.latenciesMs[0]).toBe(100);
  });

  test("rejects missing provenance, missing metrics and invalid numbers", () => {
    for (const patch of [
      { evidence: {} }, { baseline: {} }, { batch: {} }, { limits: {} },
      ...[
        { latenciesMs: [] }, { latenciesMs: [NaN] }, { latenciesMs: [Infinity] },
        { latenciesMs: [0] }, { seconds: 0 }, { errors: 101 }, { errors: 0.5 },
        { startedAtMs: -1 }, { startedAtMs: undefined },
      ].map(patch => ({ mixed: { ...measurements().mixed, ...patch } })),
    ]) expect(() => evaluateWorkerPerformance({ ...measurements(), ...patch }))
      .toThrow("WORKER_PERFORMANCE_EVIDENCE_INVALID");
  });

  test("fails latency, throughput, errors, backlog and incomplete batches independently", () => {
    const input = measurements();
    input.mixed.latenciesMs.fill(250);
    input.mixed.errors = 1;
    input.mixed.seconds = 20;
    input.batch.completed = 19;
    input.batch.seconds = 61;
    input.batch.peakOldestQueueAgeSeconds = 31;
    expect(evaluateWorkerPerformance(input).failures).toEqual([
      "MIXED_THROUGHPUT", "MIXED_P95", "MIXED_P99", "MIXED_ERROR_RATE",
      "MIXED_P99_REGRESSION", "BATCH_INCOMPLETE", "BATCH_DEADLINE", "QUEUE_AGE",
    ]);
  });

  test("cannot pass by degrading the baseline or supplying too few samples", () => {
    const input = measurements();
    input.baseline.latenciesMs.fill(300);
    input.mixed.latenciesMs = [80];
    const result = evaluateWorkerPerformance(input);
    expect(result.passed).toBe(false);
    expect(result.failures).toContain("BASELINE_P99");
    expect(result.failures).toContain("MIXED_INSUFFICIENT_SAMPLES");
  });

  test("rejects an API window outside the batch and a contaminated baseline", () => {
    const input = measurements();
    input.mixed.startedAtMs = 1060000;
    expect(evaluateWorkerPerformance(input).failures).toContain("MIXED_WINDOW_OUTSIDE_BATCH");
    input.baseline.startedAtMs = input.batch.startedAtMs;
    expect(evaluateWorkerPerformance(input).failures).toContain("BASELINE_OVERLAPS_LOAD");
    input.mixed.startedAtMs = input.batch.startedAtMs - 1;
    expect(evaluateWorkerPerformance(input).failures).toContain("MIXED_WINDOW_OUTSIDE_BATCH");
  });

  test("CLI emits a service or gate result and exits nonzero without leaking invalid input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scw-delivery-"));
    const input = join(directory, "input.json");
    const run = (script: string, args = [input]) => Bun.spawnSync([
      process.execPath, "--no-env-file",
      new URL(`../scripts/${script}.ts`, import.meta.url).pathname, ...args,
    ]);
    try {
      await Bun.write(input, JSON.stringify(manifest));
      const rendered = run("delivery");
      expect(rendered.exitCode).toBe(0);
      expect(new TextDecoder().decode(rendered.stdout)).toBe(renderWorkerService(manifest));
      await Bun.write(input, JSON.stringify(measurements()));
      expect(run("performance").exitCode).toBe(0);
      const failure = measurements();
      failure.batch.completed = 0;
      await Bun.write(input, JSON.stringify(failure));
      const failed = run("performance");
      expect(failed.exitCode).toBe(1);
      expect(JSON.parse(new TextDecoder().decode(failed.stdout)).failures).toContain("BATCH_INCOMPLETE");
      await Bun.write(input, '{"connectionString":"secret-sentinel"');
      for (const script of ["delivery", "performance"]) {
        const invalid = run(script);
        expect(invalid.exitCode).toBe(1);
        expect(new TextDecoder().decode(invalid.stderr)).not.toContain("secret-sentinel");
        expect(new TextDecoder().decode(invalid.stdout)).toBe("");
        expect(run(script, []).exitCode).toBe(1);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
