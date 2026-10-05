import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { mkdtemp, rm, readdir, realpath, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseWorkerExecutionGroup, resolveWorkerRoute, workerResourceUsage, assertWorkerBudget, type WorkerExecutionGroup,
} from "../packages/delivery/src/worker-execution";
import { parseDeliveryOptions } from "../packages/delivery/src/delivery-schema";
import { createDeliveryPlan } from "../packages/compiler/src/delivery-plan";
import type { ApplicationGraph } from "../packages/compiler/src/types";
import { applicationRuntimePlan, ApplicationSystemdRuntime } from "../packages/management-api/src/services/application-runtime";
import { assertManagedSystemdUnitContent } from "../packages/management-api/src/services/systemd-unit-broker";
import { runtimeInput } from "../packages/management-api/tests/helpers/application-runtime";
import { ApplicationReadiness } from "../packages/management-api/src/services/application-readiness";
import { executionQueueOptions, workerEnvelope, workerExecutionFromEnvironment } from "../packages/worker/src/execution-group";
import { admitWorkerOperation, releaseWorkerOperation, requireDrainedWorkerGroup, type WorkerTransaction } from "../packages/worker/src/admission";
import { createQueueHandler } from "../packages/worker/src/queue-handler";
import type { EdgeWorker } from "../packages/worker/node_modules/@pgflow/edge-worker";
import { withPgflowDatabase, until } from "../packages/worker/tests/fixtures/database";
import { createReportExport } from "../packages/worker/examples/report-export";
import { renderDeliveryWorkerEntry } from "../packages/compiler/src/delivery-worker";
import { measureWorkerApiLoad } from "../packages/worker/src/acceptance";
import { ensureApplicationRuntimeAllocationSchema } from "../packages/management-api/src/db/application-runtime-allocation-schema";
import { ApplicationRuntimeAllocations } from "../packages/management-api/src/services/application-runtime-allocation";
import { ApplicationReleaseStorage } from "../packages/management-api/src/services/application-release-storage";
import { ApplicationRuntimeFiles } from "../packages/management-api/src/services/application-runtime-files";
import { canonical, digest } from "../packages/delivery/src/delivery-files";
import { deliveryObjectDigest, type DeliveryBuildManifest } from "../packages/delivery/src/delivery-build-schema";
import { ApplicationDeploymentService, type ApplicationDeploymentDependencies } from "../packages/management-api/src/services/application-deployment";
import { createApplicationWorkerRetirementChecks } from "../packages/management-api/src/services/application-worker-retirement";
import type { ApplicationActiveRecord } from "../packages/management-api/src/services/application-activation";
import type { ApplicationRuntimeAllocation } from "../packages/management-api/src/services/application-runtime-allocation";
import { ApplicationMigrations } from "../packages/management-api/src/services/application-migrations";
import { activationJournal } from "../packages/management-api/tests/helpers/application-activation-journal";

const group: WorkerExecutionGroup = {
  name: "reports-batch-v1", target: "jobs", workloadClass: "batch", executor: "pgflow-queue", runtime: "bun",
  queue: "scw_reports_v1", taskKey: "report.generate", definitionVersion: "1",
  replicas: 2, maxReplicas: 3, concurrencyPerReplica: 2,
  resources: { cpuLimit: 0.5, memoryLimitMiB: 256 },
  database: { engineConnectionsPerReplica: 2, handlerConnectionsPerReplica: 2 },
  lifecycle: { executionTimeoutSeconds: 120, visibilityTimeoutSeconds: 180, shutdownGraceSeconds: 30 },
  retry: { maxAttempts: 3 }, admission: { maxOutstandingOperations: 2 },
};
const graph: ApplicationGraph = {
  modules: [{
    name: "Reports", className: "ReportsModule", file: "reports.ts", line: 1, imports: [],
    providers: [{ token: "Report", tokenKind: "class", kind: "class", scope: "job", deps: [], exported: false, file: "reports.ts", line: 2 }],
    controllers: [], commands: [], queries: [], exports: [],
    jobs: [{ name: "report.generate", className: "Report", serviceKey: "Report", scope: "job" }],
  }], externalTokens: [],
};
const delivery = {
  version: 1, execution: { groups: [group] },
  runtime: { processIsolation: true, durableQueue: true, capabilities: [] },
  build: { workerApplications: [{ target: "jobs", source: "worker.ts" }] },
};
function input() {
  const value = runtimeInput();
  value.release.targets[1]!.execution = structuredClone(group);
  return value;
}
const running = "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\nInvocationID=" + "a".repeat(32) + "\nResult=success\n";
function limits(unit: string) {
  return `CPUQuotaPerSecUSec=500ms\nMemoryMax=268435456\nMemorySwapMax=0\nCPUAccounting=yes\nMemoryAccounting=yes\nKillMode=control-group\nControlGroup=/system.slice/${unit}\n`;
}
type Context = Parameters<Parameters<typeof EdgeWorker.startQueueWorker>[0]>[1];
function context(): Context {
  return {
    env: {}, shutdownSignal: new AbortController().signal,
    workerConfig: { connectionString: "postgres://test:test@localhost/test", maxConcurrent: 2, maxPollSeconds: 2,
      pollIntervalMs: 200, batchSize: 2, visibilityTimeout: 180 },
    rawMessage: { msg_id: 1, read_ct: 1, enqueued_at: new Date().toISOString(), vt: new Date().toISOString(), message: null },
  };
}
function transaction(sql: Pick<SQL, "unsafe">): WorkerTransaction {
  return { query: async (text, values = []) => {
    const result: unknown = await sql.unsafe(text, [...values]);
    return result;
  } };
}

function deploymentFixture(replaceRoute = false) {
  const runtime = { ...input(), bunVersion: "1.4.2" };
  const hosts = { api: ["reports.example.test"] };
  let active: ApplicationActiveRecord | null = replaceRoute ? {
    schema: "supacloud.application-active.v1", runtime: {
      ...structuredClone(runtime), activationId: crypto.randomUUID(), ports: { api: 31001 },
    }, configurationDigest: "a".repeat(64), hosts,
  } : null;
  if (replaceRoute) {
    runtime.release.targets[1]!.execution = { ...group, name: "reports-batch-v2", queue: "scw_reports_v2", definitionVersion: "2" };
  }
  const request = {
    runtime, hosts, environment: { api: {}, jobs: {} }, expectedActivationId: active?.runtime.activationId ?? null,
    principal: { type: "project" as const, id: "project:demo" },
  };
  const allocation: ApplicationRuntimeAllocation = {
    schema: "supacloud.application-runtime-allocation.v1", runtime: structuredClone(runtime),
    configurationId: crypto.randomUUID(), createdAt: new Date().toISOString(),
  };
  const calls: string[] = [];
  const storage = new class extends ApplicationReleaseStorage {
    override async readRelease() { return structuredClone(runtime.release); }
  }();
  const dependencies: ApplicationDeploymentDependencies = {
    storage, mutations: activationJournal().journal,
    active: {
      read: async () => structuredClone(active),
      write: async record => { active = structuredClone(record); },
      confirm: async record => { expect(record).toEqual(active!); },
    },
    allocations: { allocate: async () => allocation, read: async () => allocation },
    migrations: new ApplicationMigrations({
      storage: { readMigrations: async () => ({
        record: runtime.release, archives: runtime.release.targets.map(target => ({
          target: target.name, objectId: target.object_id, artifactVerified: true, migrations: [],
        })),
      }) }, inventory: async () => [],
    }),
    verifyCompatibility: async () => { calls.push("compatibility"); },
    files: { prepare: async () => { calls.push("files"); return "/unused"; } },
    runtime: {
      install: async value => { calls.push("install"); return applicationRuntimePlan(value); },
      start: async () => { calls.push("start"); return []; },
      stop: async () => { calls.push("stop"); return []; },
      requireStopped: async () => [],
    },
    readiness: { requireReady: async value => ({
      project_ref: value.release.project_ref, application_id: value.release.application_id,
      environment_id: value.environmentId, release_id: value.release.release_id,
      activation_id: value.activationId, ready: true,
      targets: applicationRuntimePlan(value).targets.map(target => ({
        target: target.name, kind: target.kind, unit: target.unit, pid: 123, invocation_id: "a".repeat(32),
        ready: true, code: "READY" as const,
      })),
    }) },
    gateway: { configureApplicationRoute: async () => { calls.push("route"); }, verifyApplicationRoute: async () => {} },
  };
  return { request, allocation, calls, dependencies };
}

describe("worker execution groups", () => {
  test("worker production types and distributable artifacts remain buildable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "worker-groups-build-"));
    try {
      for (const args of [
        ["-p", "tsconfig.json", "--outDir", directory],
        ["-p", "tsconfig.test.json"],
      ]) {
        const child = Bun.spawn(["bun", "node_modules/typescript/bin/tsc", ...args], {
          cwd: new URL("../packages/worker", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
        });
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect(stdout + stderr).toBe("");
        expect(exit).toBe(0);
      }
      expect(await Bun.file(join(directory, "group-worker.js")).exists()).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  test("legacy configurations remain valid and new groups fail closed", () => {
    expect(parseDeliveryOptions({ version: 1 })).toEqual({ version: 1 });
    expect(parseDeliveryOptions(delivery).execution?.groups).toEqual([group]);
    for (const invalid of [
      { ...group, runtime: "go" }, { ...group, executor: "another-poller" },
      { ...group, queue: "scw_reports" }, { ...group, definitionVersion: "2" },
      { ...group, replicas: 4 }, { ...group, deadlineIsHard: true },
      { ...group, lifecycle: { ...group.lifecycle, visibilityTimeoutSeconds: 179 } },
    ]) expect(() => parseWorkerExecutionGroup(invalid)).toThrow();
    expect(() => parseDeliveryOptions({ ...delivery, execution: { groups: [group, group] } })).toThrow();
    expect(() => resolveWorkerRoute([group], "unknown", "1")).toThrow();
    expect(resolveWorkerRoute([group], "report.generate", "1").queue).toBe("scw_reports_v1");
  });

  test("fixed offered-rate measurements count errors and saturation instead of hiding them", async () => {
    const spec = {
      durationMs: 100, requestsPerSecond: 100, maxInFlight: 1, requestTimeoutMs: 50,
      p95Ms: 100, p99Ms: 200, maxErrorRate: 0, maxLatencyRegression: 0.2, drainTimeoutMs: 1000,
    };
    const sample = await measureWorkerApiLoad(spec, async () => { await Bun.sleep(30); return false; });
    expect(sample.offered).toBe(10);
    expect(sample.dropped).toBeGreaterThan(0);
    expect(sample.errors + sample.dropped).toBe(10);
    expect(sample.errorRate).toBe(1);
    await expect(measureWorkerApiLoad({ ...spec, requestsPerSecond: Infinity }, async () => true)).rejects.toThrow();
  });

  test("resource budgets include all replicas and both connection pools", () => {
    const usage = workerResourceUsage([group]);
    expect(usage).toEqual({ cpu: 1.5, memoryMiB: 768, connections: 12, concurrency: 6 });
    expect(() => assertWorkerBudget(usage, usage)).not.toThrow();
    expect(() => assertWorkerBudget(usage, { ...usage, connections: 11 })).toThrow("WORKER_BUDGET_EXCEEDED");
    expect(() => assertWorkerBudget(usage, null)).toThrow("WORKER_BUDGET_REQUIRED");
  });

  test("compiler binds one Job/host per group and includes policy changes in identity", () => {
    const result = createDeliveryPlan(graph, delivery);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.plan.targets[0]?.execution).toEqual(group);
    const changed = createDeliveryPlan(graph, { ...delivery, execution: { groups: [{ ...group, concurrencyPerReplica: 1 }] } });
    expect(changed.ok && changed.plan.topologyDigest).not.toBe(result.plan.topologyDigest);
    expect(createDeliveryPlan(graph, { ...delivery, build: {} }).ok).toBe(false);
    expect(createDeliveryPlan(graph, { ...delivery, execution: { groups: [{ ...group, taskKey: "wrong" }] } }).ok).toBe(false);
  });

  test("immutable archive import preserves execution policy and replicates only logical-target environment", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "worker-group-archive-")));
    try {
      const planned = createDeliveryPlan(graph, delivery);
      if (!planned.ok) throw new Error(JSON.stringify(planned.diagnostics));
      const kind = "bun-worker-application" as const;
      const contents = new Map([
        ["bundle/index.js", "export {};\n"],
        ["bundle/target.json", canonical({ target: planned.plan.targets[0], entryKind: kind, deploymentReady: false })],
      ]);
      const files = [...contents].map(([path, bytes]) => ({ path, sha256: digest(bytes), bytes: Buffer.byteLength(bytes) }));
      const object = { name: "jobs", inputDigest: "a".repeat(64), entryKind: kind, files,
        objectId: deliveryObjectDigest({ inputDigest: "a".repeat(64), entryKind: kind, files }),
        entrypoint: "bundle/index.js" as const, runtimeImports: [] };
      const manifest: DeliveryBuildManifest = {
        schemaVersion: 1, producer: "@supacloud/compiler/delivery-build-v1", deploymentReady: false,
        plan: planned.plan, objects: [object], routes: [], jobs: [{ name: group.taskKey, target: "jobs" }],
      };
      const manifestPath = join(directory, "delivery.manifest.json");
      await Bun.write(manifestPath, canonical(manifest));
      await mkdir(join(directory, "objects", object.objectId, "bundle"), { recursive: true });
      for (const [path, bytes] of contents) await Bun.write(join(directory, "objects", object.objectId, path), bytes);
      const storage = new ApplicationReleaseStorage(join(directory, "releases"));
      const release = await storage.importRelease({
        projectRef: "fixture", applicationId: "reports", manifestPath, expectedObjects: { jobs: object.objectId },
      });
      expect(release.targets[0]?.execution).toEqual(group);
      expect((await storage.readArchive("fixture", "reports", release.release_id)).record).toEqual(release);
      const runtime = { release, activationId: crypto.randomUUID(), environmentId: "test", ports: {} };
      const runtimeFiles = new ApplicationRuntimeFiles(storage, join(directory, "runtime"));
      const prepared = await runtimeFiles.prepare(runtime, { jobs: { REPORT_BUCKET: "fixture-bucket" } });
      expect(await Bun.file(join(prepared, "jobs-r1.env")).text()).toContain("REPORT_BUCKET");
      expect(await Bun.file(join(prepared, "jobs-r2.env")).text()).toBe(await Bun.file(join(prepared, "jobs-r1.env")).text());
      await expect(runtimeFiles.prepare(runtime, { jobs: { SUPACLOUD_WORKER_EXECUTION: "forged" } })).rejects.toThrow();
      const altered = structuredClone(manifest);
      altered.plan.targets[0]!.execution!.concurrencyPerReplica++;
      await Bun.write(manifestPath, canonical(altered));
      await expect(storage.importRelease({
        projectRef: "fixture", applicationId: "reports", manifestPath, expectedObjects: { jobs: object.objectId },
      })).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("runtime expands bounded replicas, enforces resources and passes both broker policies", async () => {
    const plan = applicationRuntimePlan(input());
    expect(plan.targets.map(target => target.name)).toEqual(["api", "jobs-r1", "jobs-r2"]);
    for (const target of plan.targets) {
      expect(() => assertManagedSystemdUnitContent(target.unit, target.unitContent)).not.toThrow();
      if (target.execution) {
        expect(target.sourceTarget).toBe("jobs");
        expect(target.unitContent).toContain("CPUQuota=50%");
        expect(target.unitContent).toContain("MemoryMax=268435456");
        expect(target.unitContent).toContain("TimeoutStopSec=35");
      }
    }
    const broker = await Bun.file(new URL("./lib/systemd_unit_broker.sh", import.meta.url)).text();
    const directory = await mkdtemp(join(tmpdir(), "worker-unit-policy-"));
    try {
      // Execute only the real validation functions, never the privileged install/remove branch.
      const start = broker.indexOf("validate_environment_file() {");
      const end = broker.indexOf('case "$operation" in');
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const validate = `${broker.slice(start, end)}\nunit_name="$1"\nsource_file="$2"\nvalidate_unit_content`;
      for (const target of plan.targets) {
        const path = join(directory, target.unit);
        for (const valid of target.execution ? [true, false] : [true]) {
          const content = valid ? target.unitContent : target.unitContent.replace("CPUQuota=50%", "CPUQuota=6500%");
          if (!valid) expect(() => assertManagedSystemdUnitContent(target.unit, content)).toThrow();
          await Bun.write(path, content);
          const child = Bun.spawn(["bash", "-c", validate, "worker-unit-policy", target.unit, path], {
            stdout: "pipe", stderr: "pipe",
          });
          const [stdout, stderr, exit] = await Promise.all([
            new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
          ]);
          expect(stdout + stderr).toBe("");
          expect(exit === 0).toBe(valid);
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    const runtime = new ApplicationSystemdRuntime({
      install: async () => {},
      command: async args => ({ exitCode: 0, stdout: running + limits(args[1]!) }),
      resources: async () => true,
    });
    expect((await runtime.inspect(input())).filter(state => state.resourcesVerified)).toHaveLength(2);
    const unenforced = new ApplicationSystemdRuntime({
      install: async () => {},
      command: async args => ({ exitCode: 0, stdout: running + limits(args[1]!) }),
    });
    expect((await unenforced.inspect(input())).some(state => state.resourcesVerified)).toBe(false);
  });

  test("managed worker policy cannot be replaced by a different replica or task version", async () => {
    const env = { SUPACLOUD_WORKER_EXECUTION: Buffer.from(JSON.stringify(group)).toString("base64"),
      SUPACLOUD_WORKER_REPLICA: "1", SUPACLOUD_TARGET: "jobs-r1" };
    expect(workerExecutionFromEnvironment(env)).toEqual(group);
    expect(() => workerExecutionFromEnvironment({ ...env, SUPACLOUD_WORKER_REPLICA: "3" })).toThrow();
    expect(executionQueueOptions(group).retryLimit).toBe(2);
    let effects = 0;
    const handler = createQueueHandler({
      projectRef: "project-a", queueName: group.queue, taskKey: group.taskKey, definitionVersion: "1",
    }, { decode: value => value, authorize: () => true, execute: () => { effects++; } });
    const envelope = workerEnvelope(group, "project-a", "operation-1", null);
    expect(() => workerEnvelope(group, "project-a", "operation-1", { value: Infinity })).toThrow("WORKER_TASK_INVALID");
    expect(() => workerEnvelope(group, "project-a", "operation-1", undefined)).toThrow("WORKER_TASK_INVALID");
    await handler(envelope, context());
    await expect(handler({ ...envelope, definitionVersion: "2" }, context())).rejects.toThrow();
    await expect(handler({ ...envelope, schemaVersion: 1 }, context())).rejects.toThrow();
    await expect(handler({ ...envelope, projectRef: "other" }, context())).rejects.toThrow();
    expect(effects).toBe(1);
  });

  test("readiness requires fresh health and enforced resources for every replica", async () => {
    const plan = applicationRuntimePlan(input());
    let ready = true, stale = false, enforced = true;
    const runtime = new ApplicationSystemdRuntime({
      install: async () => {}, command: async args => ({ exitCode: 0, stdout: running + limits(args[1]!) }),
      resources: async () => enforced,
    });
    const identity = (name: string, objectId: string, kind: "http" | "worker") => ({
      schema: "supacloud.application-runtime.v1", project_ref: plan.projectRef, application_id: plan.applicationId,
      environment_id: plan.environmentId, release_id: plan.releaseId, activation_id: plan.activationId,
      object_id: objectId, target: name, kind, pid: 123,
    });
    const readiness = new ApplicationReadiness({
      observe: value => runtime.inspect(value),
      http: async () => ({ ready: true, identity: identity("api", plan.targets[0]!.objectId, "http") }),
      journal: async unit => {
        const target = plan.targets.find(target => target.unit === unit)!;
        return JSON.stringify({ _PID: "123", _SYSTEMD_INVOCATION_ID: "a".repeat(32), MESSAGE: JSON.stringify({
          event: "delivery-worker-health", identity: identity(target.name, target.objectId, "worker"),
          ready, observedAt: new Date(Date.now() - (stale ? 60000 : 0)).toISOString(),
        }) });
      },
    });
    expect((await readiness.inspect(input())).ready).toBe(true);
    ready = false; expect((await readiness.inspect(input())).ready).toBe(false);
    ready = true; stale = true; expect((await readiness.inspect(input())).ready).toBe(false);
    stale = false; enforced = false; expect((await readiness.inspect(input())).ready).toBe(false);
  });

  test("group activation requires a matching live reservation before process or traffic changes", async () => {
    for (const invalid of ["absent", "retired", "mismatched"] as const) {
      const f = deploymentFixture();
      if (invalid === "absent") f.dependencies.allocations!.read = async () => null;
      if (invalid === "retired") f.allocation.retiredAt = new Date().toISOString();
      if (invalid === "mismatched") f.allocation.runtime.release.targets[1]!.execution!.concurrencyPerReplica++;
      await expect(new ApplicationDeploymentService(f.dependencies).activate(f.request)).rejects.toThrow("WORKER_ALLOCATION_REQUIRED");
      expect(f.calls).toEqual([]);
    }
    const f = deploymentFixture();
    expect((await new ApplicationDeploymentService(f.dependencies).activate(f.request)).replayed).toBe(false);
    expect(f.calls).toEqual(["compatibility", "files", "install", "start", "route"]);
  });

  test("route replacement requires successful old-group retirement evidence before stopping workers", async () => {
    for (const mode of ["missing", "not-drained", "drained"] as const) {
      const f = deploymentFixture(true);
      if (mode !== "missing") f.dependencies.verifyWorkerRetirement = async value => {
        expect(value.groups).toHaveLength(1);
        expect(value.groups[0]!.queue).toBe("scw_reports_v1");
        expect(value.previous.runtime.release.targets[1]!.execution!.queue).toBe("scw_reports_v1");
        expect(value.runtime.release.targets[1]!.execution!.queue).toBe("scw_reports_v2");
        if (mode === "not-drained") throw new Error("WORKER_GROUP_NOT_DRAINED");
        f.calls.push("drained");
      };
      const activation = new ApplicationDeploymentService(f.dependencies).activate(f.request);
      if (mode === "drained") {
        await activation;
        expect(f.calls).toEqual(["drained", "compatibility", "files", "install", "stop", "start", "route"]);
      } else {
        await expect(activation).rejects.toThrow(mode === "missing" ? "WORKER_RETIREMENT_VERIFIER_REQUIRED" : "WORKER_GROUP_NOT_DRAINED");
        expect(f.calls).toEqual([]);
      }
    }
  });

  test("allocation retirement proves only worker routes absent from the active release", async () => {
    const f = deploymentFixture();
    const drained: string[] = [];
    f.dependencies.active!.readForApplication = async () => null;
    f.dependencies.configurations = { resolve: async () => ({
      bunVersion: "1.4.2", environment: { api: {}, jobs: {} }, hosts: { api: ["reports.example.test"] },
    }) };
    f.dependencies.retirementVerifier = async () => {};
    f.dependencies.verifyWorkerAllocationRetirement = async ({ groups }) => {
      drained.push(...groups.map(group => group.queue));
    };
    f.dependencies.allocations!.retire = async () => ({
      ...f.allocation, retiredAt: new Date().toISOString(),
    });
    await new ApplicationDeploymentService(f.dependencies).retireConfigured({
      projectRef: "demo", applicationId: "reviews", environmentId: "test",
      activationId: f.request.runtime.activationId, principal: f.request.principal,
    });
    expect(drained).toEqual(["scw_reports_v1"]);
  });

  test("default retirement evidence is read-only and requires admission to be paused first", async () => {
    const queries: string[] = [];
    const checks = createApplicationWorkerRetirementChecks(async (_project, verify) => {
      await verify({ query: async (text) => {
        queries.push(text);
        return [{ accepting: false, outstanding: "0", held: "0", queued: "0" }];
      } });
    });
    await checks.verifyWorkerAllocationRetirement({ runtime: input(), groups: [group] });
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain("UPDATE supacloud_worker.admission_limits");
    const paused = createApplicationWorkerRetirementChecks(async (_project, verify) => {
      await verify({ query: async () => [{ accepting: true, outstanding: 0, held: 0, queued: 0 }] });
    });
    await expect(paused.verifyWorkerAllocationRetirement({ runtime: input(), groups: [group] }))
      .rejects.toThrow("WORKER_GROUP_NOT_DRAINED");
  });

  test.skipIf(process.env.WORKER_GROUP_DATABASE_ACCEPTANCE !== "1")(
    "real PostgreSQL atomic admission, rollback, replay and domain-terminal release",
    async () => {
      await withPgflowDatabase(async (db, url, install) => {
        await install();
        await ensureApplicationRuntimeAllocationSchema(db);
        const allocator = new ApplicationRuntimeAllocations({
          database: db, range: { start: 45000, end: 45010 }, reservedPorts: async () => [], isAvailable: async () => true,
          workerBudget: workerResourceUsage([group]),
        });
        const allocations = await Promise.allSettled([1, 2].map(() => {
          const value = input();
          return allocator.allocate({
            runtime: { release: value.release, environmentId: value.environmentId, activationId: crypto.randomUUID() },
            configurationId: crypto.randomUUID(),
          });
        }));
        expect(allocations.filter(result => result.status === "fulfilled")).toHaveLength(1);
        expect(allocations.filter(result => result.status === "rejected")).toHaveLength(1);
        await db`INSERT INTO supacloud_worker.admission_limits(group_name,max_outstanding) VALUES ('reports-batch-v1',1)`;
        const binding = { projectRef: "fixture", group: "reports-batch-v1", operationId: "one" };
        const request = (id: string) => db.begin(tx => admitWorkerOperation(transaction(tx), { ...binding, operationId: id }, "a".repeat(64)));
        const results = await Promise.allSettled([request("one"), request("two")]);
        expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
        expect(results.filter(item => item.status === "rejected")).toHaveLength(1);
        const [held] = await db`SELECT operation_id FROM supacloud_worker.admission_tokens WHERE NOT released`;
        const existing = { ...binding, operationId: String(held.operation_id) };
        expect(await db.begin(tx => admitWorkerOperation(transaction(tx), existing, "a".repeat(64)))).toEqual({ admitted: false });
        await expect(db.begin(tx => admitWorkerOperation(transaction(tx), existing, "b".repeat(64)))).rejects.toThrow("WORKER_OPERATION_CONFLICT");
        await expect(db.begin(tx => releaseWorkerOperation(transaction(tx), existing, async () => "unknown"))).rejects.toThrow();
        expect((await db`SELECT outstanding FROM supacloud_worker.admission_limits`)[0].outstanding).toBe(1);
        await db.begin(tx => releaseWorkerOperation(transaction(tx), existing, async () => "succeeded"));
        await db.begin(tx => releaseWorkerOperation(transaction(tx), existing, async () => "succeeded"));
        expect(await request(existing.operationId)).toEqual({ admitted: false });
        await expect(db.begin(async tx => {
          await admitWorkerOperation(transaction(tx), { ...binding, operationId: "rollback" }, "c".repeat(64));
          throw new Error("domain-rollback");
        })).rejects.toThrow("domain-rollback");
        expect((await db`SELECT outstanding FROM supacloud_worker.admission_limits`)[0].outstanding).toBe(0);
        expect((await db`SELECT * FROM supacloud_worker.admission_tokens WHERE operation_id='rollback'`).length).toBe(0);
        await expect(db.begin(tx => admitWorkerOperation(transaction(tx), { ...binding, projectRef: "other" }, "a".repeat(64))))
          .rejects.toThrow("WORKER_PROJECT_MISMATCH");
        await db.unsafe(await Bun.file(new URL("../packages/worker/examples/report-export.sql", import.meta.url)).text());
        await db`SELECT pgmq.create('scw_reports_v1')`;
        await expect(db.begin(connection => requireDrainedWorkerGroup(transaction(connection), "fixture", binding.group, group.queue)))
          .rejects.toThrow("WORKER_GROUP_NOT_DRAINED");
        await db`UPDATE supacloud_worker.admission_limits SET accepting=false`;
        await db.begin(connection => requireDrainedWorkerGroup(transaction(connection), "fixture", binding.group, group.queue));
        await expect(request("paused-new")).rejects.toThrow("WORKER_ADMISSION_PAUSED");
        expect(await request(existing.operationId)).toEqual({ admitted: false });
        await db`UPDATE supacloud_worker.admission_limits SET accepting=true`;
        const realGroup = {
          ...group, replicas: 1, maxReplicas: 1, concurrencyPerReplica: 1,
          lifecycle: { executionTimeoutSeconds: 1, visibilityTimeoutSeconds: 36, shutdownGraceSeconds: 5 },
          admission: { maxOutstandingOperations: 1 },
        };
        const reports = createReportExport({ projectRef: "fixture", connectionString: url, group: realGroup }, {
          authorize: async identity => identity.actorId === "operator" && identity.tenantId === "tenant-a",
          page: async () => { throw new Error("producer cannot execute"); },
          open: async () => { throw new Error("producer cannot execute"); },
        });
        const directory = await realpath(await mkdtemp(join(tmpdir(), "worker-group-recovery-")));
        const processes: ReturnType<typeof Bun.spawn>[] = [];
        const outputs: Promise<string>[] = [];
        try {
          const entrypoint = join(directory, "entry.ts");
          await Bun.write(entrypoint, `const createCompiledModules = () => new Map();\n`
            + renderDeliveryWorkerEntry(directory, new URL("./fixtures/worker-execution-host.ts", import.meta.url).pathname));
          const spawn = (fault?: "crash" | "hang") => {
            const child = Bun.spawn(["bun", "--no-env-file", entrypoint], {
              env: {
                ...process.env, WORKER_GROUP_TEST_DATABASE_URL: url, WORKER_GROUP_TEST_ARTIFACT_ROOT: directory,
                SUPACLOUD_PROJECT_REF: "fixture", SUPABASE_URL: "http://localhost:54321",
                SUPABASE_SERVICE_ROLE_KEY: "fixture-local-only",
                SUPACLOUD_WORKER_EXECUTION: Buffer.from(JSON.stringify(realGroup)).toString("base64"),
                SUPACLOUD_WORKER_REPLICA: "1", SUPACLOUD_TARGET: "jobs-r1", SHUTDOWN_TIMEOUT_MS: "5000",
                ...(fault === "crash" ? { WORKER_GROUP_TEST_CRASH: "1" } : {}),
                ...(fault === "hang" ? { WORKER_GROUP_TEST_HANG: "1" } : {}),
              }, stdout: "pipe", stderr: "pipe",
            });
            processes.push(child);
            const timeout = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 20_000);
            void child.exited.finally(() => clearTimeout(timeout));
            outputs.push(Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]).then(parts => parts.join("")));
            return child;
          };
          const operation = crypto.randomUUID();
          const identity = { actorId: "operator", tenantId: "tenant-a" };
          const source = { sourceId: "sales", revision: "1" };
          expect((await reports.submit(identity, source, operation)).replayed).toBe(false);
          expect((await reports.submit(identity, source, operation)).replayed).toBe(true);
          expect((await db`SELECT message FROM pgmq.q_scw_reports_v1`)[0].message)
            .toEqual(workerEnvelope(realGroup, "fixture", operation, { requestId: operation }));
          const crashed = spawn("crash");
          const crashExit = await crashed.exited;
          expect({ exit: crashExit, details: crashExit === 91 ? "" : await outputs.at(-1)! }).toEqual({ exit: 91, details: "" });
          expect(await reports.result(identity, operation)).toBeNull();
          expect((await db`SELECT outstanding FROM supacloud_worker.admission_limits`)[0].outstanding).toBe(1);
          // Keep the crash recovery test short; the lease itself is exercised, not bypassed by a new message.
          await db`UPDATE pgmq.q_scw_reports_v1 SET vt=clock_timestamp() WHERE message->>'idempotencyKey'=${operation}`;
          const restarted = spawn();
          await until(async () => await reports.result(identity, operation) !== null);
          const result = await reports.result(identity, operation);
          expect(result?.rows).toBe(3);
          expect(await Bun.file(join(directory, result!.objectId)).text()).toContain(`"'=formula","3"`);
          expect((await readdir(directory)).filter(name => name.endsWith(".csv"))).toHaveLength(1);
          expect((await db`SELECT outstanding FROM supacloud_worker.admission_limits`)[0].outstanding).toBe(0);
          await expect(reports.result({ ...identity, tenantId: "other" }, operation)).rejects.toThrow("FORBIDDEN");
          restarted.kill("SIGTERM");
          expect(await restarted.exited).toBe(0);
          const hangOperation = crypto.randomUUID();
          await reports.submit(identity, source, hangOperation);
          const timedOut = spawn("hang");
          expect(await timedOut.exited).toBe(1);
          expect(await reports.result(identity, hangOperation)).toBeNull();
          expect((await db`SELECT outstanding FROM supacloud_worker.admission_limits`)[0].outstanding).toBe(1);
          expect((await db`SELECT read_ct FROM pgmq.q_scw_reports_v1 WHERE message->>'idempotencyKey'=${hangOperation}`)[0].read_ct).toBe(1);
        } finally {
          for (const child of processes) if (child.exitCode === null) child.kill("SIGKILL");
          await Promise.all(processes.map(child => child.exited));
          const logs = await Promise.all(outputs);
          for (const log of logs) expect(log).not.toContain("fixture-local-only");
          await reports.close();
          await rm(directory, { recursive: true, force: true });
        }
      });
    }, 180_000,
  );
});
