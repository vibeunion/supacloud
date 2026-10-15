import { expect, test } from "bun:test";
import type { ApplicationConfigurationView, ApplicationDeployResult } from "@supacloud/delivery";
import type { ProjectTask } from "../../src/db";
import {
  ApplicationDeploymentTasks, parseApplicationDeploymentTask, type ApplicationDeploymentTaskPorts,
} from "../../src/services/application-deployment-task";
import {
  ApplicationDeploymentOrchestrationError,
  type ApplicationDeploymentOrchestrationInput, type ApplicationDeploymentStatus,
} from "../../src/services/application-deployment-orchestrator";
import { ApplicationDeploymentWorker } from "../../src/workers/application-deployment.worker";

const mutationId = "11234567-89ab-4def-8123-456789abcdef";
const configurationId = "21234567-89ab-4def-8123-456789abcdef";
const input: ApplicationDeploymentOrchestrationInput = {
  projectRef: "demo", applicationId: "api", environmentId: "test",
  request: { mutation_id: mutationId, release_id: "a".repeat(64) },
  principal: { type: "project", id: "project:demo" },
};
const configuration: ApplicationConfigurationView = {
  schema: "supacloud.application-configuration.v1",
  project_ref: "demo", application_id: "api", environment_id: "test",
  configuration_id: configurationId, created_at: "2026-10-15T00:00:00.000Z",
  bun_version: "1.3.0", targets: [{ name: "api", kind: "http", hosts: [], environment_names: [] }],
};
const receipt: ApplicationDeployResult = {
  schema: "supacloud.application-deploy.v1", project_ref: "demo", application_id: "api", environment_id: "test",
  mutation_id: mutationId, release_id: input.request.release_id, configuration_id: configurationId,
  activation_id: "31234567-89ab-4def-8123-456789abcdef", expected_activation_id: null,
  plan_sha256: "b".repeat(64), action: "activate", replayed: false, execution_performed: true,
  backend_receipt: {
    schema: "supacloud.application-backend-receipt.v1",
    project_ref: "demo", application_id: "api", environment_id: "test",
    mutation_id: mutationId, release_id: input.request.release_id, manifest_sha256: "c".repeat(64),
    plan_sha256: "b".repeat(64), backup_id: null, before_ledger_digest: "d".repeat(64),
    after_ledger_digest: "d".repeat(64), applied_versions: [], schema_reloaded: false, postgrest_healthy: true,
  },
};

function fixture() {
  const records = new Map<string, ProjectTask>();
  const writes: unknown[] = [];
  let observations: ApplicationDeploymentStatus | null = null;
  let reads = 0;
  const ports: ApplicationDeploymentTaskPorts = {
    create: async candidate => {
      if (typeof candidate === "string") throw new Error("Object input required");
      const previous = records.get(candidate.idempotencyKey!);
      if (previous) return structuredClone(previous);
      const task: ProjectTask = {
        id: crypto.randomUUID(), project_ref: candidate.ref, task_type: candidate.type,
        status: "pending", payload: candidate.payload ?? {}, error: null,
        retries: 0, attempt: 0, max_attempts: candidate.maxAttempts ?? 3,
        next_run_at: new Date(), lease_until: null, started_at: null, completed_at: null,
        timeout_sec: candidate.timeoutSec ?? null, idempotency_key: candidate.idempotencyKey ?? null,
        trace_id: null, cancel_requested_at: null, cancellation_reason: null,
        correlation_id: null, business_task_id: candidate.businessTaskId ?? null,
        invoker_user_id: null, auth_authority_ref: candidate.ref, metadata: candidate.metadata ?? null,
        function_slug: null, function_version: null, result: null, created_at: new Date(), updated_at: new Date(),
      };
      records.set(task.idempotency_key!, task);
      return structuredClone(task);
    },
    read: async (_project, key) => records.get(key) ?? null,
    configurations: {
      read: async () => { reads++; return structuredClone(configuration); },
      put: async (_scope, write) => { writes.push(write); return structuredClone(configuration); },
    },
  };
  const orchestrator = { status: async () => observations };
  const tasks = new ApplicationDeploymentTasks(orchestrator, ports);
  return {
    tasks, ports, records, writes, orchestrator, reads: () => reads,
    task: () => {
      const task = [...records.values()][0];
      if (!task) throw new Error("Missing task");
      return task;
    },
    observe: (value: ApplicationDeploymentStatus | null) => { observations = value; },
  };
}

function successState(): ApplicationDeploymentStatus {
  return {
    mutation_id: mutationId, operation: "application.release.deploy", status: "succeeded", phase: "verifying",
    project_ref: "demo", application_id: "api", environment_id: "test", receipt, failure_code: null,
  };
}

test("durable acceptance pins configuration, exposes queued status, and replays without new writes", async () => {
  const f = fixture();
  expect(await f.tasks.submit(input)).toEqual({ replayed: false });
  expect(await f.tasks.submit(input)).toEqual({ replayed: true });
  expect(f.records.size).toBe(1);
  expect(f.reads()).toBe(1);
  expect(parseApplicationDeploymentTask(f.task()).request.configuration_id).toBe(configurationId);
  expect(await f.tasks.status("demo", mutationId)).toMatchObject({ status: "pending", phase: "queued", receipt: null });
});

test("configuration values are not placed in the public task payload or metadata", async () => {
  const f = fixture();
  await f.tasks.submit({ ...input, request: {
    ...input.request, configuration_write: {
      configuration_id: configurationId, expected_configuration_id: null,
      configuration: {
        bun_version: "1.3.0",
        targets: [{ name: "api", kind: "http", hosts: [], environment: { PRIVATE: "never-in-task" } }],
      },
    },
  } });
  expect(f.writes).toHaveLength(1);
  expect(JSON.stringify(f.task())).not.toContain("never-in-task");
  expect(f.task().payload.request).not.toHaveProperty("configuration_write");
});

test.each([
  { ...input, environmentId: "production" },
  { ...input, request: { ...input.request, release_id: "f".repeat(64) } },
  { ...input, principal: { type: "master" as const, id: "another" } },
])("idempotency rejects a different request or principal", async other => {
  const f = fixture();
  await f.tasks.submit(input);
  await expect(f.tasks.submit(other)).rejects.toMatchObject({ statusCode: 409 });
  expect(f.reads()).toBe(1);
  expect(f.records.size).toBe(1);
});

test("failed insertion cannot return accepted", async () => {
  const f = fixture();
  f.ports.create = async () => { throw new Error("database unavailable"); };
  await expect(f.tasks.submit(input)).rejects.toThrow("database unavailable");
});

test("concurrent identical submissions produce one task", async () => {
  const f = fixture();
  await Promise.all([f.tasks.submit(input), f.tasks.submit(input)]);
  expect(f.records.size).toBe(1);
});

test("a queue success alone never means a verified release success", async () => {
  const f = fixture();
  await f.tasks.submit(input);
  f.task().status = "succeeded";
  expect(await f.tasks.status("demo", mutationId)).toMatchObject({ status: "outcome_unknown", receipt: null });
  f.observe(successState());
  expect(await f.tasks.status("demo", mutationId)).toMatchObject({ status: "succeeded", receipt });
});

test("tampered payload and foreign receipts cannot be consumed", async () => {
  const f = fixture();
  await f.tasks.submit(input);
  f.observe({ ...successState(), receipt: { ...receipt, release_id: "f".repeat(64) } });
  await expect(f.tasks.status("demo", mutationId)).rejects.toThrow();
  f.task().payload.application_id = "other";
  expect(() => parseApplicationDeploymentTask(f.task())).toThrow();
});

test("lost acknowledgement reuses the mutation receipt without running the deploy again", async () => {
  const f = fixture();
  await f.tasks.submit(input);
  let calls = 0;
  const finishes: unknown[] = [];
  const worker = new ApplicationDeploymentWorker({
    status: async () => successState(),
    execute: async () => { calls++; return receipt; },
  }, {
    claim: async () => null, heartbeat: async () => true,
    finish: async (_task, outcome, code) => { finishes.push({ outcome, code }); },
  });
  await worker.process(f.task());
  expect(calls).toBe(0);
  expect(finishes).toEqual([{ outcome: "succeeded", code: null }]);
});

test("worker executes once and validates the result before acknowledging", async () => {
  const f = fixture();
  await f.tasks.submit(input);
  const calls: unknown[] = [];
  const worker = new ApplicationDeploymentWorker({
    status: async () => null,
    execute: async request => { calls.push(request); return receipt; },
  }, {
    claim: async () => null, heartbeat: async () => true,
    finish: async (_task, outcome) => { calls.push(outcome); },
  });
  await worker.process(f.task());
  expect(calls).toEqual([
    { ...input, request: { ...input.request, configuration_id: configurationId } }, "succeeded",
  ]);
});

test.each(["running", "outcome_unknown"] as const)("worker never replays an interrupted %s mutation", async status => {
  const f = fixture();
  await f.tasks.submit(input);
  const finishes: unknown[] = [];
  const worker = new ApplicationDeploymentWorker({
    status: async () => ({ ...successState(), status, receipt: null }),
    execute: async () => { throw new Error("must not execute"); },
  }, {
    claim: async () => null, heartbeat: async () => true,
    finish: async (_task, outcome, code) => { finishes.push({ outcome, code }); },
  });
  await worker.process(f.task());
  expect(finishes).toEqual([{ outcome: "failed", code: "APPLICATION_DEPLOY_RECONCILIATION_REQUIRED" }]);
});

test("known pre-execution rejection is terminal; transient pre-execution error is bounded retry", async () => {
  for (const error of [new ApplicationDeploymentOrchestrationError("APPLICATION_DEPLOY_PLAN_CHANGED", 409),
    new Error("temporary-provider-secret")]) {
    const f = fixture();
    await f.tasks.submit(input);
    f.task().attempt = 1;
    const finishes: string[] = [];
    const worker = new ApplicationDeploymentWorker({
      status: async () => null, execute: async () => { throw error; },
    }, {
      claim: async () => null, heartbeat: async () => true,
      finish: async (_task, outcome, code) => { finishes.push(outcome); expect(code).not.toContain("secret"); },
    });
    await worker.process(f.task());
    expect(finishes).toEqual([error instanceof ApplicationDeploymentOrchestrationError ? "failed" : "retry_scheduled"]);
  }
});

test("lost task ownership prevents execution and acknowledgement", async () => {
  const f = fixture();
  await f.tasks.submit(input);
  const calls: string[] = [];
  const worker = new ApplicationDeploymentWorker({
    status: async () => null, execute: async () => { calls.push("execute"); return receipt; },
  }, {
    claim: async () => null, heartbeat: async () => false,
    finish: async () => { calls.push("finish"); },
  });
  await worker.process(f.task());
  expect(calls).toEqual([]);
});
