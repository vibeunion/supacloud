import { expect, test } from "bun:test";
import { ApplicationPreviewService } from "../../src/services/application-preview.service";
import type { ApplicationPreviewProbeInput, StoredApplicationPreview } from "../../src/services/application-preview-contract";
import { ApplicationPreviewConflictError } from "../../src/repositories/project-config-writes";
import { type ApplicationPreviewServiceDependencies } from "../../src/services/application-preview.service";
import { createApplicationPreviewReadiness } from "../../src/services/application-preview-readiness";
import { applicationReleaseId, type ApplicationReadinessReport } from "@supacloud/delivery";
import { runtimeInput } from "../helpers/application-runtime";

const configurationId = "91234567-89ab-4def-8123-456789abcdef";

function releases(): ApplicationPreviewServiceDependencies["releases"] {
  const record = runtimeInput().release;
  return {
    readRelease: async (projectRef, applicationId, releaseId) => ({
      ...record, project_ref: projectRef, application_id: applicationId, release_id: releaseId,
    }),
    materializeRelease: async (_projectRef, applicationId, _releaseId, branchRef) => ({
      ...record, project_ref: branchRef, application_id: applicationId,
      release_id: applicationReleaseId(branchRef, applicationId, record.manifest_sha256),
    }),
  };
}

function activation(): Pick<ApplicationPreviewServiceDependencies, "configurations" | "activate"> {
  return {
    configurations: { clone: async (_source, target) => ({
      schema: "supacloud.application-configuration.v1", configuration_id: configurationId,
      project_ref: target.projectRef, application_id: target.applicationId, environment_id: target.environmentId,
      created_at: "2026-10-10T00:00:00.000Z", bun_version: "1.4.2",
      targets: [],
    }) },
    activate: async input => ({ activation_id: input.activationId }),
  };
}

function project(config: Record<string, unknown> = {}) {
  return { config, ref: "demo" } as never;
}

function previewStore(configs: Record<string, unknown>[], onSave: () => void = () => {}) {
  return {
    findByRef: async (_ref: string) => project(structuredClone(configs[0])),
    saveApplicationPreview: async (_ref: string, input: StoredApplicationPreview, expected: string | null) => {
      await Promise.resolve();
      const current = (configs[0]?.application_previews ?? []) as StoredApplicationPreview[];
      const index = current.findIndex(item => item.preview_id === input.preview_id);
      if (expected === null ? index >= 0 : current[index]?.updated_at !== expected) {
        throw new ApplicationPreviewConflictError();
      }
      const receipt = structuredClone(input);
      receipt.updated_at = new Date(Math.max(Date.now(), expected === null ? 0 : Date.parse(expected) + 1)).toISOString();
      configs[0] = { ...configs[0], application_previews: index < 0 ? [...current, receipt]
        : current.map((item, position) => position === index ? receipt : item) };
      onSave();
      return structuredClone(receipt);
    },
  };
}

test("preview provisioning reaches ready only after all isolated resources and smoke pass", async () => {
  const configs: Record<string, unknown>[] = [{}];
  const calls: string[] = [];
  const service = new ApplicationPreviewService({
    releases: releases(),
    ...activation(),
    projects: previewStore(configs),
    branches: {
      createBranch: async () => { calls.push("branch:create"); },
      deleteBranch: async () => { calls.push("branch:delete"); },
    },
    queues: {
      createQueue: async () => { calls.push("queue:create"); },
      dropQueue: async () => { calls.push("queue:drop"); return true; },
      listQueues: async () => [],
    },
    secrets: {
      upsertSecrets: async () => { calls.push("secret:create"); return true; },
      deleteSecret: async () => { calls.push("secret:delete"); return true; },
    },
    invalidateEnv: async () => true,
    runtime: { checkStatus: async () => ({ status: "running", health: "healthy" } as never) },
    smokeTest: async () => ({ passed: ["application_readiness"], failed: [] }),
  });
  const initial = await service.create({
    projectRef: "demo", applicationId: "api", environmentId: "test", releaseId: "a".repeat(64),
  });
  expect(initial.status).toBe("provisioning");
  const receipts = await service.list("demo", "api", "test");
  expect(receipts[0]).toMatchObject({ status: "ready", resources: { smoke_test: { status: "ready", failed: [] } } });
  expect(receipts[0]?.resources.configuration_revision).toEqual({ status: "ready", configuration_id: configurationId });
  expect(receipts[0]?.resources.application_activation.status).toBe("ready");
  expect(receipts[0]?.resources.smoke_test.passed).toEqual(expect.arrayContaining(receipts[0]?.resources.smoke_test.checks ?? []));
  expect(calls).toEqual(["branch:create", "queue:create", "secret:create"]);
});

test("preview cleanup is explicit and idempotent at the receipt boundary", async () => {
  const configs: Record<string, unknown>[] = [{}];
  const calls: string[] = [];
  const service = new ApplicationPreviewService({
    releases: releases(),
    projects: previewStore(configs),
    branches: {
      createBranch: async () => {},
      deleteBranch: async () => { calls.push("branch:delete"); },
    },
    queues: {
      createQueue: async () => {},
      dropQueue: async () => { calls.push("queue:drop"); return true; },
      listQueues: async () => [],
    },
    secrets: {
      upsertSecrets: async () => true,
      deleteSecret: async () => { calls.push("secret:delete"); return true; },
    },
    invalidateEnv: async () => true,
    runtime: { checkStatus: async () => ({ status: "running", health: "healthy" } as never) },
    smokeTest: async () => ({ passed: [], failed: ["application_readiness"] }),
  });
  const initial = await service.create({
    projectRef: "demo", applicationId: "api", environmentId: "test", releaseId: "b".repeat(64),
  });
  const cleaned = await service.cleanup("demo", initial.preview_id);
  expect(cleaned).toMatchObject({ status: "cleaned", cleanup: { completed: true } });
  expect(await service.cleanup("demo", initial.preview_id)).toEqual(cleaned);
  expect(calls).toEqual(["queue:drop", "secret:delete", "branch:delete"]);
});

test("preview reads resume a persisted provisioning receipt without recreating its branch", async () => {
  const previewId = "12345678-1234-4234-8234-123456789abc";
  const branchRef = "pv123456781234423482";
  const configs: Record<string, unknown>[] = [{
    application_previews: [{
      schema: "supacloud.application-preview.v1", preview_id: previewId,
      project_ref: "demo", application_id: "api", environment_id: "test", release_id: "c".repeat(64),
      status: "provisioning", branch_name: "existing-preview", queue_name: "preview_123456781234423482",
      test_secret_name: "PREVIEW_TOKEN_123456781234423482",
      created_at: "2026-10-07T00:00:00.000Z", updated_at: "2026-10-07T00:00:00.000Z",
      resources: {
        build_artifact: { status: "ready", release_id: "c".repeat(64) },
        database_branch: { status: "ready", branch_ref: branchRef, data_mode: "schema_only" },
        queue_namespace: { status: "pending", namespace: "preview_123456781234423482" },
        storage_namespace: { status: "pending", namespace: branchRef },
        test_secret: { status: "pending", name: "PREVIEW_TOKEN_123456781234423482", value_issued: false },
        smoke_test: {
          status: "pending", checks: ["release_artifact", "database_branch", "queue_namespace", "storage_namespace", "test_secret", "application_readiness"],
          passed: [], failed: [],
        },
      },
      cleanup: { required: true, completed: false, error: null },
    }],
  }];
  const calls: string[] = [];
  const service = new ApplicationPreviewService({
    releases: releases(),
    ...activation(),
    projects: {
      ...previewStore(configs),
      findByRef: async ref => ref === branchRef
        ? ({ ref: branchRef, config: { parent_ref: "demo" } } as never) : project(configs[0]),
    },
    branches: {
      createBranch: async () => { calls.push("branch:create"); },
      deleteBranch: async () => {},
    },
    queues: {
      createQueue: async () => { calls.push("queue:create"); },
      dropQueue: async () => true, listQueues: async () => [],
    },
    secrets: {
      upsertSecrets: async () => { calls.push("secret:create"); return true; },
      deleteSecret: async () => true,
    },
    invalidateEnv: async () => true,
    runtime: { checkStatus: async () => ({ status: "running", health: "healthy" } as never) },
    smokeTest: async () => ({ passed: ["application_readiness"], failed: [] }),
  });
  expect(await service.get("demo", previewId)).toMatchObject({ status: "ready" });
  expect(calls).toEqual(["queue:create", "secret:create"]);
});

test("concurrent creates across service instances preserve every receipt and unrelated configuration", async () => {
  const configs: Record<string, unknown>[] = [{ owner_setting: "before" }];
  const start = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const projects = previewStore(configs, () => {
    const all = configs[0]?.application_previews as StoredApplicationPreview[];
    if (all.length === 12 && all.every(item => item.status === "ready")) finished.resolve();
  });
  const make = () => new ApplicationPreviewService({
    releases: releases(),
    ...activation(),
    projects,
    branches: { createBranch: async () => { await start.promise; }, deleteBranch: async () => {} },
    queues: { createQueue: async () => {}, dropQueue: async () => true, listQueues: async () => [] },
    secrets: { upsertSecrets: async () => true, deleteSecret: async () => true },
    invalidateEnv: async () => true,
    runtime: { checkStatus: async () => ({ status: "running", health: "healthy" } as never) },
    smokeTest: async () => ({ passed: ["application_readiness"], failed: [] }),
  });
  const instances = [make(), make()];
  const created = await Promise.all(Array.from({ length: 12 }, (_, index) => instances[index % 2]!.create({
    projectRef: "demo", applicationId: "api", environmentId: "test", releaseId: "d".repeat(64),
  })));
  configs[0] = { ...configs[0], owner_setting: "after" };
  start.resolve();
  await finished.promise;
  const receipts = await instances[0]!.list("demo", "api", "test");
  expect(receipts.map(item => item.preview_id).sort()).toEqual(created.map(item => item.preview_id).sort());
  expect(receipts.every(item => item.status === "ready")).toBe(true);
  expect(configs[0]?.owner_setting).toBe("after");
});

test("an initial receipt write failure never starts branch or queue provisioning", async () => {
  let started = false;
  const service = new ApplicationPreviewService({
    releases: releases(),
    projects: {
      findByRef: async () => project(),
      saveApplicationPreview: async () => { throw new Error("storage unavailable"); },
    },
    branches: { createBranch: async () => { started = true; }, deleteBranch: async () => {} },
  });
  await expect(service.create({ projectRef: "demo", applicationId: "api", environmentId: "test", releaseId: "e".repeat(64) }))
    .rejects.toThrow("storage unavailable");
  expect(started).toBe(false);
});

function provisioningFixture(overrides: Partial<ApplicationPreviewServiceDependencies> = {}) {
  const configs: Record<string, unknown>[] = [{}];
  const dependencies: ApplicationPreviewServiceDependencies = {
    releases: releases(),
    ...activation(),
    projects: previewStore(configs),
    branches: { createBranch: async () => {}, deleteBranch: async () => {} },
    queues: { createQueue: async () => {}, dropQueue: async () => true, listQueues: async () => [] },
    secrets: { upsertSecrets: async () => true, deleteSecret: async () => true },
    invalidateEnv: async () => true,
    runtime: { checkStatus: async () => ({ status: "running", health: "healthy" } as never) },
    smokeTest: async () => ({ passed: ["application_readiness"], failed: [] }),
    ...overrides,
  };
  const service = new ApplicationPreviewService(dependencies);
  return { configs, service, dependencies };
}

test("missing configuration, activation or explicit readiness evidence cannot yield a ready preview", async () => {
  const cases: Array<{ overrides: Partial<ApplicationPreviewServiceDependencies>; missing: string }> = [
    { overrides: { configurations: undefined }, missing: "configuration_revision" },
    { overrides: { configurations: { clone: async () => null } }, missing: "configuration_revision" },
    { overrides: { activate: undefined }, missing: "application_activation" },
    { overrides: { smokeTest: undefined }, missing: "application_readiness" },
    { overrides: { smokeTest: async () => ({ passed: [], failed: [] }) }, missing: "application_readiness" },
    { overrides: { smokeTest: async () => ({ passed: ["tenant_runtime"], failed: ["application_readiness"] }) }, missing: "application_readiness" },
  ];
  for (const { overrides, missing } of cases) {
    const { service } = provisioningFixture(overrides);
    const created = await service.create({ projectRef: "demo", applicationId: "api", environmentId: "test", releaseId: "a".repeat(64) });
    const receipt = await service.get("demo", created.preview_id);
    expect(receipt?.status).toBe("failed");
    expect(receipt?.resources.smoke_test.status).toBe("failed");
    expect(receipt?.resources.smoke_test.failed).toContain(missing);
    expect(receipt?.cleanup).toMatchObject({ required: true, completed: false });
  }
});

test("a failing application smoke cannot hide unhealthy tenant runtime or fabricate core resource evidence", async () => {
  const { service } = provisioningFixture({
    configurations: undefined,
    runtime: { checkStatus: async () => ({ status: "stopped", health: "unhealthy" } as never) },
    smokeTest: async () => ({
      passed: ["configuration_revision", "application_activation", "tenant_runtime", "application_readiness"], failed: ["custom_probe"],
    }),
  });
  const created = await service.create({ projectRef: "demo", applicationId: "api", environmentId: "test", releaseId: "a".repeat(64) });
  const receipt = await service.get("demo", created.preview_id);
  expect(receipt?.resources.smoke_test.failed).toEqual(expect.arrayContaining([
    "configuration_revision", "application_activation", "application_readiness", "tenant_runtime",
  ]));
  expect(receipt?.resources.smoke_test.passed).not.toContain("tenant_runtime");
  expect(receipt?.resources.smoke_test.passed).not.toContain("configuration_revision");
});

test("tenant runtime failure is retained alongside a real application smoke failure", async () => {
  const { service } = provisioningFixture({
    runtime: { checkStatus: async () => ({ status: "stopped", health: "unhealthy" } as never) },
    smokeTest: async () => ({ passed: [], failed: ["application_readiness", "route_probe"] }),
  });
  const created = await service.create({ projectRef: "demo", applicationId: "api", environmentId: "test", releaseId: "a".repeat(64) });
  const receipt = await service.get("demo", created.preview_id);
  expect(receipt?.status).toBe("failed");
  expect(receipt?.resources.smoke_test.failed).toEqual(expect.arrayContaining([
    "tenant_runtime", "application_readiness", "route_probe",
  ]));
});

test("a foreign artifact cannot be accepted as the branch release or start provisioning", async () => {
  let started = false;
  const adapter = releases();
  const { service } = provisioningFixture({
    releases: {
      ...adapter,
      materializeRelease: async (source, applicationId, releaseId) => adapter.readRelease(source, applicationId, releaseId),
    },
    branches: { createBranch: async () => { started = true; }, deleteBranch: async () => {} },
  });
  await expect(service.create({ projectRef: "demo", applicationId: "api", environmentId: "test", releaseId: "a".repeat(64) }))
    .rejects.toThrow("APPLICATION_PREVIEW_RELEASE_IDENTITY_MISMATCH");
  expect(started).toBe(false);
});

test("activation identity is persisted before effects and reused after process recovery", async () => {
  const blocked = Promise.withResolvers<void>();
  const invoked = Promise.withResolvers<void>();
  let saved: StoredApplicationPreview | undefined;
  let attemptedId: string | undefined;
  const fixture = provisioningFixture({
    activate: async input => {
      attemptedId = input.activationId;
      const receipts = fixture.configs[0]?.application_previews as StoredApplicationPreview[];
      saved = structuredClone(receipts[0]!);
      expect(saved.resources.application_activation).toEqual({ status: "pending", activation_id: attemptedId });
      expect(saved.resources.configuration_revision).toEqual({ status: "ready", configuration_id: configurationId });
      invoked.resolve();
      await blocked.promise;
      throw new ApplicationPreviewConflictError();
    },
  });
  const created = await fixture.service.create({
    projectRef: "demo", applicationId: "api", environmentId: "test", releaseId: "a".repeat(64),
  });
  await invoked.promise;
  expect(saved).toBeDefined();
  const recoveredConfigs: Record<string, unknown>[] = [{ application_previews: [saved] }];
  let clones = 0;
  const recovered = new ApplicationPreviewService({
    ...fixture.dependencies,
    projects: previewStore(recoveredConfigs),
    configurations: { clone: async () => { clones++; throw new Error("Must reuse configuration"); } },
    activate: async input => {
      expect(input.activationId).toBe(attemptedId);
      expect(input.configurationId).toBe(configurationId);
      return { activation_id: input.activationId };
    },
  });
  try {
    expect(await recovered.get("demo", created.preview_id)).toMatchObject({ status: "ready" });
    expect(clones).toBe(0);
  } finally {
    blocked.resolve();
    await expect(fixture.service.get("demo", created.preview_id)).rejects.toBeInstanceOf(ApplicationPreviewConflictError);
  }
});

test("an activation response with a different identity fails without a fabricated success", async () => {
  const { service } = provisioningFixture({
    activate: async () => ({ activation_id: "81234567-89ab-4def-8123-456789abcdef" }),
  });
  const created = await service.create({ projectRef: "demo", applicationId: "api", environmentId: "test", releaseId: "a".repeat(64) });
  const receipt = await service.get("demo", created.preview_id);
  expect(receipt?.status).toBe("failed");
  expect(receipt?.resources.application_activation.status).toBe("pending");
  expect(receipt?.resources.smoke_test.failed).toContain("provisioning");
});

function readinessFixture() {
  const runtime = runtimeInput();
  const current = {
    schema: "supacloud.application-active.v1" as const,
    runtime, configurationId, configurationDigest: "d".repeat(64),
  };
  const input: ApplicationPreviewProbeInput = {
    projectRef: "parent", branchRef: runtime.release.project_ref, applicationId: runtime.release.application_id,
    environmentId: runtime.environmentId, releaseId: runtime.release.release_id, configurationId, activationId: runtime.activationId,
  };
  const report: ApplicationReadinessReport = {
    project_ref: input.branchRef, application_id: input.applicationId, environment_id: input.environmentId,
    release_id: input.releaseId, activation_id: input.activationId, ready: true,
    targets: [{ target: "api", kind: "http", unit: "fixture.service", pid: 1, invocation_id: "fixture", ready: true, code: "READY" }],
  };
  return { current, input, report };
}

test("default preview readiness probes the exact branch activation and rereads authority", async () => {
  const { current, input, report } = readinessFixture();
  const calls: string[] = [];
  const probe = createApplicationPreviewReadiness({
    active: { readForApplication: async (project, application, environment) => {
      expect([project, application, environment]).toEqual([input.branchRef, input.applicationId, input.environmentId]);
      calls.push("read");
      return structuredClone(current);
    } },
    readiness: { inspect: async runtime => { expect(runtime).toEqual(current.runtime); calls.push("probe"); return report; } },
  });
  expect(await probe(input)).toEqual({ passed: ["application_readiness"], failed: [] });
  expect(calls).toEqual(["read", "probe", "read"]);
});

test("preview readiness rejects foreign, changed, absent and unavailable runtime evidence", async () => {
  const { current, input, report } = readinessFixture();
  const changes: Array<Partial<ApplicationPreviewProbeInput>> = [
    { branchRef: "other" }, { applicationId: "other" }, { environmentId: "other" },
    { releaseId: "f".repeat(64) }, { configurationId: "81234567-89ab-4def-8123-456789abcdef" },
    { activationId: "81234567-89ab-4def-8123-456789abcdef" },
  ];
  for (const change of changes) {
    let probes = 0;
    const probe = createApplicationPreviewReadiness({
      active: { readForApplication: async () => current },
      readiness: { inspect: async () => { probes++; return report; } },
    });
    expect(await probe({ ...input, ...change })).toEqual({ passed: [], failed: ["application_readiness"] });
    expect(probes).toBe(0);
  }
  for (const invalidReport of [
    { ...report, ready: false }, { ...report, activation_id: "81234567-89ab-4def-8123-456789abcdef" },
    { ...report, project_ref: "parent" }, { ...report, targets: [] },
    { ...report, targets: report.targets.map(target => ({ ...target, ready: false })) },
  ]) {
    const probe = createApplicationPreviewReadiness({
      active: { readForApplication: async () => current }, readiness: { inspect: async () => invalidReport },
    });
    expect(await probe(input)).toEqual({ passed: [], failed: ["application_readiness"] });
  }
  for (const changed of [null, {
    ...current, runtime: { ...current.runtime, activationId: "81234567-89ab-4def-8123-456789abcdef" },
  }]) {
    let reads = 0;
    const probe = createApplicationPreviewReadiness({
      active: { readForApplication: async () => reads++ === 0 ? current : changed },
      readiness: { inspect: async () => report },
    });
    expect(await probe(input)).toEqual({ passed: [], failed: ["application_readiness"] });
  }
  const probe = createApplicationPreviewReadiness({
    active: { readForApplication: async () => { throw new Error("private-provider-credential"); } },
    readiness: { inspect: async () => report },
  });
  expect(await probe(input)).toEqual({ passed: [], failed: ["application_readiness"] });
});
