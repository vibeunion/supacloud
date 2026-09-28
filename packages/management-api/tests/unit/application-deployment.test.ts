import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ApplicationDeploymentService, type ApplicationDeploymentDependencies, type DeployApplicationInput,
} from "../../src/services/application-deployment";
import { ApplicationReleaseStorage } from "../../src/services/application-release-storage";
import { ApplicationActiveStorage } from "../../src/services/application-active-storage";
import { ApplicationMigrations } from "../../src/services/application-migrations";
import { applicationRuntimePlan } from "../../src/services/application-runtime";
import type { ApplicationGatewayInput } from "../../src/services/application-gateway";
import { runtimeInput } from "../helpers/application-runtime";
import { activationJournal } from "../helpers/application-activation-journal";
import type { ApplicationRuntimeAllocation } from "../../src/services/application-runtime-allocation";
import { createApplicationRoutes } from "../../src/routes/applications";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "application-deployment-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function fixture() {
  const input: DeployApplicationInput = {
    runtime: runtimeInput(), environment: { api: {}, jobs: {} }, hosts: { api: ["reviews.example.test"] },
    expectedActivationId: null, principal: { type: "project", id: "project:demo" },
  };
  const { journal, states } = activationJournal();
  const calls: string[] = [];
  let routed: ApplicationGatewayInput | null = null;
  const active = new ApplicationActiveStorage(join(root, "active"));
  const storage = new class extends ApplicationReleaseStorage {
    override async readRelease() { return input.runtime.release; }
  }();
  const migrations = new ApplicationMigrations({
    storage: { readMigrations: async () => ({ record: input.runtime.release, archives: input.runtime.release.targets.map(target => ({
      target: target.name, objectId: target.object_id, artifactVerified: true, migrations: [],
    })) }) },
    inventory: async () => [],
  });
  const dependencies: ApplicationDeploymentDependencies = {
    storage, active, mutations: journal, migrations,
    verifyCompatibility: async report => {
      calls.push("compatibility");
      expect(report.migrations.compatibility).toBe("not-proven");
    },
    files: { prepare: async () => { calls.push("files"); return root; } },
    runtime: {
      install: async runtime => { calls.push("install"); return applicationRuntimePlan(runtime); },
      start: async () => { calls.push("start"); return []; },
      stop: async () => { calls.push("stop"); return []; },
      requireStopped: async () => { calls.push("stopped"); return []; },
    },
    readiness: { requireReady: async runtime => {
      calls.push("ready");
      return {
        project_ref: runtime.release.project_ref, application_id: runtime.release.application_id,
        environment_id: runtime.environmentId, release_id: runtime.release.release_id,
        activation_id: runtime.activationId, ready: true,
        targets: applicationRuntimePlan(runtime).targets.map(target => ({
          target: target.name, kind: target.kind, unit: target.unit, pid: 123, invocation_id: "a".repeat(32),
          ready: true, code: "READY" as const,
        })),
      };
    } },
    gateway: {
      configureApplicationRoute: async value => { calls.push("route"); routed = structuredClone(value); },
      verifyApplicationRoute: async value => {
        calls.push("verify");
        expect(value).toEqual(routed!);
      },
    },
  };
  return { input, dependencies, active, states, calls, journal, service: new ApplicationDeploymentService(dependencies) };
}

test("deployment composes prepare, install, readiness, traffic and durable authority in order", async () => {
  const f = fixture();
  await f.service.activate(f.input);
  expect(f.calls).toEqual(["compatibility", "files", "install", "start", "ready", "route", "verify", "ready", "verify"]);
  expect((await f.active.read(f.input.runtime))?.hosts).toEqual(f.input.hosts);
  f.calls.length = 0;
  expect((await f.service.activate(f.input)).replayed).toBe(true);
  expect(f.calls).toEqual(["ready", "verify"]);
});

test("retirement rejects a foreign application before configuration resolution, verification or claim release", async () => {
  const f = fixture();
  const allocation: ApplicationRuntimeAllocation = {
    schema: "supacloud.application-runtime-allocation.v1", runtime: f.input.runtime,
    configurationId: "91234567-89ab-4def-8123-456789abcdef", createdAt: new Date().toISOString(),
  };
  const effects: string[] = [];
  const service = new ApplicationDeploymentService({
    ...f.dependencies,
    configurations: { resolve: async () => { effects.push("configuration"); throw new Error("Unexpected resolve"); } },
    retirementVerifier: async () => { effects.push("verify"); },
    allocations: {
      allocate: async () => { throw new Error("Unexpected allocation"); },
      read: async () => structuredClone(allocation),
      retire: async () => { effects.push("release"); return allocation; },
    },
  });
  await expect(service.retireConfigured({
    projectRef: "demo", applicationId: "different", environmentId: "test",
    activationId: f.input.runtime.activationId, principal: f.input.principal,
  })).rejects.toThrow("APPLICATION_PORT_ALLOCATION_IDENTITY_INVALID");
  expect(effects).toEqual([]);
  expect(f.calls).toEqual([]);
});

test("configured activation resolves an explicit scope-bound revision before mutation effects", async () => {
  const f = fixture();
  const configurationId = "91234567-89ab-4def-8123-456789abcdef";
  const savedEnvironment = { api: { APP_SETTING: "revision-config-fixture" }, jobs: {} };
  const service = new ApplicationDeploymentService({
    ...f.dependencies,
    configurations: { resolve: async (scope, id, release) => {
      expect(scope).toEqual({ projectRef: "demo", applicationId: "reviews", environmentId: "test" });
      expect(id).toBe(configurationId);
      expect(release).toEqual(f.input.runtime.release);
      expect(f.states.size).toBe(0);
      return { bunVersion: "1.4.2", environment: savedEnvironment, hosts: { api: ["configured.example.test"] } };
    } },
    allocations: { allocate: async input => {
      expect(input.configurationId).toBe(configurationId);
      expect("ports" in input.runtime).toBe(false);
      expect(input.runtime.release).toEqual(f.input.runtime.release);
      expect(f.states.size).toBe(0);
      return {
        schema: "supacloud.application-runtime-allocation.v1",
        configurationId, runtime: { ...input.runtime, ports: { api: 21000 } }, createdAt: new Date().toISOString(),
      };
    } },
    files: { prepare: async (runtime, environment) => {
      expect(environment).toEqual(savedEnvironment);
      expect(runtime.ports).toEqual({ api: 21000 });
      return root;
    } },
  });
  await service.activateConfigured({
    runtime: f.input.runtime, configurationId, expectedActivationId: null, principal: f.input.principal,
  });
  expect((await f.active.read(f.input.runtime))?.hosts).toEqual({ api: ["configured.example.test"] });
  expect((await f.active.read(f.input.runtime))?.configurationId).toBe(configurationId);
  expect((await f.active.read(f.input.runtime))?.runtime.ports).toEqual({ api: 21000 });
  expect(JSON.stringify(f.states.get(f.input.runtime.activationId))).not.toContain("revision-config-fixture");
});

test("configured deployment cannot allocate a forged release or activate a foreign allocation", async () => {
  const f = fixture();
  let allocations = 0;
  const service = new ApplicationDeploymentService({
    ...f.dependencies,
    configurations: { resolve: async () => ({
      bunVersion: "1.4.2", environment: { api: {}, jobs: {} }, hosts: { api: ["reviews.example.test"] },
    }) },
    allocations: { allocate: async input => {
      allocations++;
      return {
        schema: "supacloud.application-runtime-allocation.v1", configurationId: input.configurationId,
        runtime: { ...input.runtime, environmentId: "foreign", ports: { api: 21000 } }, createdAt: new Date().toISOString(),
      };
    } },
  });
  const request = {
    runtime: structuredClone(f.input.runtime), configurationId: "91234567-89ab-4def-8123-456789abcdef",
    expectedActivationId: null, principal: f.input.principal,
  };
  request.runtime.release.created_at = "2026-09-25T00:00:00.000Z";
  await expect(service.activateConfigured(request)).rejects.toThrow("RELEASE_MISMATCH");
  expect(allocations).toBe(0);
  request.runtime.release = f.input.runtime.release;
  await expect(service.activateConfigured(request)).rejects.toThrow("ALLOCATION_MISMATCH");
  expect(allocations).toBe(1);
  expect(f.states.size).toBe(0);
  expect(f.calls).toEqual([]);
});

test("configuration revision identity remains in activation fingerprints and recovery checkpoints", async () => {
  const f = fixture();
  f.input.configurationId = "91234567-89ab-4def-8123-456789abcdef";
  await f.service.activate(f.input);
  expect((f.states.get(f.input.runtime.activationId)!.checkpoint.desired as { configurationId: string })
    .configurationId).toBe(f.input.configurationId);
  await expect(f.service.activate({
    ...f.input, configurationId: "a1234567-89ab-4def-8123-456789abcdef",
  })).rejects.toThrow("mutation conflict");
  expect((await f.service.reconcile({
    projectRef: "demo", applicationId: "reviews", environmentId: "test",
    activationId: f.input.runtime.activationId, principal: f.input.principal,
  })).replayed).toBe(true);
});

test("deployment does not install or stop processes when compatibility fails", async () => {
  const f = fixture();
  f.dependencies.verifyCompatibility = async () => { throw new Error("schema incompatible"); };
  await expect(f.service.activate(f.input)).rejects.toThrow("schema incompatible");
  expect(f.calls).toEqual([]);
  expect(f.states.get(f.input.runtime.activationId)!.status).toBe("failed_terminal");
});

test("deployment rejects unapplied migrations before compatibility or runtime effects", async () => {
  const f = fixture();
  const report = await f.dependencies.migrations!.inspect("demo", "reviews", f.input.runtime.release.release_id);
  f.dependencies.migrations!.inspect = async () => ({ ...report, project_migrations_applied: false });
  await expect(f.service.activate(f.input)).rejects.toThrow("MIGRATIONS_NOT_APPLIED");
  expect(f.calls).toEqual([]);
});

test("upgrades must not reuse a port still named by the previous application route", async () => {
  const f = fixture();
  await f.service.activate(f.input);
  const next = structuredClone(f.input);
  next.runtime.activationId = "11234567-89ab-4def-8123-456789abcdef";
  next.expectedActivationId = f.input.runtime.activationId;
  f.calls.length = 0;
  await expect(f.service.activate(next)).rejects.toThrow("PORT_CONFLICT");
  expect(f.calls).toEqual([]);
  next.runtime.activationId = "21234567-89ab-4def-8123-456789abcdef";
  next.runtime.ports = { api: 32000 };
  await f.service.activate(next);
  expect(f.calls.indexOf("stop")).toBeLessThan(f.calls.indexOf("start"));
});

test("deployment recovery uses persisted hosts without replaying effects", async () => {
  const f = fixture();
  f.journal.success = async () => { throw new Error("receipt lost"); };
  await expect(f.service.activate(f.input)).rejects.toThrow("receipt lost");
  f.calls.length = 0;
  await f.service.reconcile({
    projectRef: "demo", applicationId: "reviews", environmentId: "test",
    activationId: f.input.runtime.activationId, principal: f.input.principal,
  });
  expect(f.calls).toEqual(["ready", "verify", "ready", "verify"]);
  expect((await f.active.read(f.input.runtime))?.hosts).toEqual(f.input.hosts);
});

test("HTTP activation with a lost journal receipt reconciles after service reconstruction without runtime replay", async () => {
  const f = fixture();
  const configurationId = "91234567-89ab-4def-8123-456789abcdef";
  const dependencies: ApplicationDeploymentDependencies = {
    ...f.dependencies,
    configurations: { resolve: async () => ({
      bunVersion: "1.4.2",
      environment: structuredClone(f.input.environment),
      hosts: Object.fromEntries(Object.entries(f.input.hosts).map(([key, hosts]) => [key, [...hosts]])),
    }) },
    allocations: { allocate: async input => ({
      schema: "supacloud.application-runtime-allocation.v1",
      configurationId: input.configurationId, runtime: { ...input.runtime, ports: { api: 21000 } },
      createdAt: new Date().toISOString(),
    }) },
  };
  const routes = () => createApplicationRoutes({
    storage: dependencies.storage, active: f.active,
    deployment: new ApplicationDeploymentService(dependencies),
    authorize: async () => undefined, projectExists: async () => true,
    principal: async () => f.input.principal,
  });
  const path = "http://localhost/v1/projects/demo/applications/reviews/environments/test/activations";
  const post = (url: string, body: unknown) => new Request(url, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  f.journal.success = async () => { throw new Error("receipt lost"); };
  const failed = await routes().handle(post(path, {
    activation_id: f.input.runtime.activationId, release_id: f.input.runtime.release.release_id,
    configuration_id: configurationId, expected_activation_id: null,
  }));
  expect(failed.status).toBe(503);
  expect(await failed.json()).toMatchObject({
    code: "APPLICATION_ACTIVATION_OUTCOME_UNKNOWN", activation_id: f.input.runtime.activationId,
  });
  expect(f.states.get(f.input.runtime.activationId)!.status).toBe("outcome_unknown");
  expect((await f.active.read(f.input.runtime))?.configurationId).toBe(configurationId);
  f.calls.length = 0;
  const restarted = routes();
  const recoveryPath = `${path}/${f.input.runtime.activationId}/reconcile`;
  const foreign = await restarted.handle(post(recoveryPath.replace("/test/", "/foreign/"), {}));
  expect(foreign.status).toBe(503);
  expect(f.states.get(f.input.runtime.activationId)!.status).toBe("outcome_unknown");
  expect(f.calls).toEqual([]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const recovered = await restarted.handle(post(recoveryPath, {}));
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({
      project_ref: "demo", application_id: "reviews", environment_id: "test",
      activation_id: f.input.runtime.activationId, release_id: f.input.runtime.release.release_id,
      replayed: true,
    });
    expect(f.states.get(f.input.runtime.activationId)!.status).toBe("succeeded");
  }
  expect(f.calls.length).toBeGreaterThan(0);
  expect(f.calls.every(call => call === "ready" || call === "verify")).toBe(true);
});

test("non-ready, incomplete or wrong-release readiness receipts cannot expose traffic", async () => {
  for (const scenario of ["not-ready", "partial", "wrong-release"]) {
    const f = fixture();
    const ready = f.dependencies.readiness!.requireReady;
    f.dependencies.readiness!.requireReady = async runtime => {
      const report = await ready(runtime);
      if (scenario === "partial") return { ...report, targets: report.targets.slice(0, 1) };
      if (scenario === "wrong-release") return { ...report, release_id: "f".repeat(64) };
      return {
        ...report, ready: false,
        targets: report.targets.map(target => ({
          ...target, ready: false, pid: 0, invocation_id: null, code: "PROCESS_NOT_RUNNING" as const,
        })),
      };
    };
    await expect(f.service.activate(f.input)).rejects.toThrow("NOT_READY");
    expect(f.calls).not.toContain("route");
    expect(f.states.get(f.input.runtime.activationId)!.status).toBe("outcome_unknown");
  }
});

test("invalid hostname bindings fail before a mutation or runtime effect", () => {
  const f = fixture();
  f.input.hosts = { jobs: ["worker.example.test"] };
  expect(() => f.service.activate(f.input)).toThrow("TARGETS_INVALID");
  expect(f.calls).toEqual([]);
  expect(f.states.size).toBe(0);
});

test("compatibility receives configuration copies without changing the fingerprinted deployment", async () => {
  const f = fixture();
  f.input.environment = { api: { APP_SETTING: "private-config-fixture" }, jobs: {} };
  f.dependencies.verifyCompatibility = async ({ runtime, environment }) => {
    expect(environment.api?.APP_SETTING).toBe("private-config-fixture");
    runtime.ports = { api: 65535 };
    (environment.api as Record<string, string>).APP_SETTING = "changed";
  };
  f.dependencies.files!.prepare = async (runtime, environment) => {
    expect(runtime.ports).toEqual({ api: 31000 });
    expect(environment.api?.APP_SETTING).toBe("private-config-fixture");
    return root;
  };
  await f.service.activate(f.input);
  expect((await f.active.read(f.input.runtime))?.runtime.ports).toEqual({ api: 31000 });
  expect(JSON.stringify(f.states.get(f.input.runtime.activationId))).not.toContain("private-config-fixture");
});
