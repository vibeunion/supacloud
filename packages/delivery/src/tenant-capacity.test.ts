import { expect, test } from "bun:test";
import { applicationReleaseId, parseApplicationReleaseRecord, type ApplicationReleaseRecord } from "./application-release";
import type { WorkerExecutionGroup } from "./worker-execution";
import {
  edgeTenantAdmission,
  emptyTenantCapacity,
  evaluateTenantCapacity,
  evaluateTenantReservation,
  parseTenantCapacityBudget,
  sharedRuntimeCapacityGaps,
  tenantCapacityFromEnvironment,
  tenantReservationFromRelease,
} from "./tenant-capacity";

const group: WorkerExecutionGroup = {
  name: "reports-batch-v1",
  target: "jobs",
  workloadClass: "batch",
  executor: "pgflow-queue",
  runtime: "bun",
  queue: "scw_reports_v1",
  taskKey: "report.generate",
  definitionVersion: "1",
  replicas: 1,
  maxReplicas: 1,
  concurrencyPerReplica: 2,
  resources: { cpuLimit: 0.5, memoryLimitMiB: 256 },
  database: { engineConnectionsPerReplica: 2, handlerConnectionsPerReplica: 1 },
  lifecycle: { executionTimeoutSeconds: 120, visibilityTimeoutSeconds: 180, shutdownGraceSeconds: 30 },
  retry: { maxAttempts: 3 },
  admission: { maxOutstandingOperations: 4 },
};

function budget(overrides: Partial<ReturnType<typeof emptyTenantCapacity>> = {}) {
  return { ...emptyTenantCapacity(), cpu: 4, memoryMiB: 4096, connections: 20, queue: 20, storageBytes: 1_000_000, functionConcurrency: 8, ...overrides };
}

function release(): ApplicationReleaseRecord {
  const manifest = "a".repeat(64);
  return parseApplicationReleaseRecord({
    schema: "supacloud.application-release.v1",
    project_ref: "demo",
    application_id: "reviews",
    manifest_sha256: manifest,
    release_id: applicationReleaseId("demo", "reviews", manifest),
    created_at: "2026-11-01T00:00:00.000Z",
    targets: [{
      name: "jobs",
      kind: "worker",
      object_id: "b".repeat(64),
      entrypoint: "bundle/index.js",
      execution: group,
    }],
  });
}

test("rejects a partial or fractional tenant budget", () => {
  expect(parseTenantCapacityBudget({ cpu: 1 })).toBeNull();
  expect(parseTenantCapacityBudget({ ...budget(), connections: 1.5 })).toBeNull();
  expect(parseTenantCapacityBudget({ ...budget(), extra: 1 })).toBeNull();
  expect(parseTenantCapacityBudget(budget())?.queue).toBe(20);
});

test("reserves cpu, memory, connections, queue admission, and function concurrency", () => {
  const reserved = tenantReservationFromRelease(release());
  expect(reserved).toEqual({
    cpu: 0.5,
    memoryMiB: 256,
    connections: 3,
    queue: 4,
    storageBytes: 0,
    functionConcurrency: 2,
  });
  const decision = evaluateTenantReservation({
    projectRef: "demo",
    budget: budget({ connections: 3, queue: 4, functionConcurrency: 2, cpu: 0.5, memoryMiB: 256 }),
    active: [release()],
    requested: release(),
  });
  expect(decision.admitted).toBe(false);
  expect(decision.dimension).toBe("cpu");
  expect(decision.projectRef).toBe("demo");

  const queue = evaluateTenantReservation({
    projectRef: "demo",
    budget: budget({ queue: 4, cpu: 2, memoryMiB: 1024, connections: 10, functionConcurrency: 8 }),
    active: [release()],
    requested: release(),
  });
  expect(queue).toMatchObject({ admitted: false, dimension: "queue", limit: 4, usage: 4, requested: 4 });

  const storage = evaluateTenantReservation({
    projectRef: "demo",
    budget: budget({ storageBytes: 0, cpu: 2, memoryMiB: 1024, connections: 10, queue: 20, functionConcurrency: 8 }),
    active: [],
    requested: release(),
  });
  expect(storage.admitted).toBe(true);
});

test("edge admission delays at the concurrency cap and rejects once the queue is full", () => {
  const limits = budget({ functionConcurrency: 1, queue: 1, memoryMiB: 64 });
  expect(edgeTenantAdmission({
    projectRef: "project-a", budget: limits, inflight: 0, queued: 0, heapBytes: 0,
  }).action).toBe("run");
  expect(edgeTenantAdmission({
    projectRef: "project-a", budget: limits, inflight: 1, queued: 0, heapBytes: 0,
  }).action).toBe("delay");
  const rejected = edgeTenantAdmission({
    projectRef: "project-a", budget: limits, inflight: 1, queued: 1, heapBytes: 0,
  });
  expect(rejected.action).toBe("reject");
  expect(rejected.decision).toMatchObject({
    projectRef: "project-a",
    dimension: "functionConcurrency",
    reason: "exceeded",
  });
  const memory = edgeTenantAdmission({
    projectRef: "project-a", budget: limits, inflight: 0, queued: 0, heapBytes: 65 * 1024 * 1024,
  });
  expect(memory.action).toBe("reject");
  expect(memory.decision.dimension).toBe("memoryMiB");
});

test("storage bytes reject only the tenant that would exceed them", () => {
  const decision = evaluateTenantCapacity({
    projectRef: "project-a",
    budget: budget({ storageBytes: 10 }),
    usage: { ...emptyTenantCapacity(), storageBytes: 8 },
    requested: { storageBytes: 4 },
    enforce: ["storageBytes"],
  });
  expect(decision).toMatchObject({ admitted: false, dimension: "storageBytes", limit: 10, usage: 8, requested: 4 });
  expect(evaluateTenantCapacity({
    projectRef: "project-b",
    budget: budget({ storageBytes: 10 }),
    usage: { ...emptyTenantCapacity(), storageBytes: 1 },
    requested: { storageBytes: 4 },
    enforce: ["storageBytes"],
  }).admitted).toBe(true);
});

test("records the shared-runtime gaps and parses the operator budget map", () => {
  expect(sharedRuntimeCapacityGaps.map(gap => gap.dimension)).toEqual(["cpu", "connections", "storageBytes"]);
  expect(tenantCapacityFromEnvironment({})).toBeUndefined();
  expect(tenantCapacityFromEnvironment({ SUPACLOUD_TENANT_CAPACITY_JSON: "null" })).toBeUndefined();
  const lookup = tenantCapacityFromEnvironment({
    SUPACLOUD_TENANT_CAPACITY_JSON: JSON.stringify({ demo: budget({ functionConcurrency: 1 }) }),
  });
  expect(lookup?.("demo")?.functionConcurrency).toBe(1);
  expect(lookup?.("other")).toBeNull();
  expect(() => tenantCapacityFromEnvironment({ SUPACLOUD_TENANT_CAPACITY_JSON: "{" })).toThrow("JSON");
  expect(() => tenantCapacityFromEnvironment({ SUPACLOUD_TENANT_CAPACITY_JSON: "{\"DEMO\":null}" })).toThrow("invalid");
});
