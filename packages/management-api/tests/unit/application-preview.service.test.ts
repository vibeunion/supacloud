import { expect, test } from "bun:test";
import { ApplicationPreviewService } from "../../src/services/application-preview.service";
import type { ApplicationPreviewProbeInput, StoredApplicationPreview } from "../../src/services/application-preview-contract";
import { ApplicationPreviewConflictError } from "../../src/repositories/project-config-writes";
import { type ApplicationPreviewServiceDependencies } from "../../src/services/application-preview.service";
import { createApplicationPreviewReadiness } from "../../src/services/application-preview-readiness";
import { applicationReleaseId, type ApplicationReadinessReport } from "@supacloud/delivery";
import { runtimeInput } from "../helpers/application-runtime";
import { runApplicationPreviewCleanupSweep } from "../../src/workers/application-preview-cleanup.worker";
import { buildApplicationPreviewReceipt } from "../../src/services/application-preview-contract";
import { cleanupEmptyPreviewStorage, createApplicationPreviewCleanupChecks } from "../../src/services/application-preview-cleanup";
import { ApplicationDeploymentService, type ApplicationDeploymentDependencies } from "../../src/services/application-deployment";
import { ApplicationActiveStorage } from "../../src/services/application-active-storage";
import type { ApplicationActiveRecord } from "../../src/services/application-activation";
import type { ApplicationRuntimeAllocation } from "../../src/services/application-runtime-allocation";
import { activationJournal } from "../helpers/application-activation-journal";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveBucketName } from "../../src/db";

const configurationId = "91234567-89ab-4def-8123-456789abcdef";
const testLifecycle: Pick<ApplicationPreviewServiceDependencies, "lifecycle" | "branchLifecycle" | "storage"> = {
  lifecycle: async (_projectRef, _previewId, operation) => operation(),
  branchLifecycle: async (_projectRef, operation) => operation(),
  storage: { createBucket: async () => ({ success: true }) },
};

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
    ...testLifecycle,
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
    ...testLifecycle,
    releases: releases(),
    cleanupChecks: {
      assertSafe: async () => {}, cleanupStorage: async () => {}, verifyBranchDeleted: async () => {},
      verifySecretDeleted: async () => {},
    },
    projects: previewStore(configs),
    branches: {
      createBranch: async () => {},
      deleteBranch: async () => { calls.push("branch:delete"); },
    },
    queues: {
      createQueue: async () => {},
      dropQueue: async () => { calls.push("queue:drop"); return true; },
      listQueues: async () => {
        const receipt = (configs[0]?.application_previews as StoredApplicationPreview[])[0]!;
        return calls.includes("queue:drop") ? [] : [{ queue_name: receipt.queue_name } as never];
      },
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
    ...testLifecycle,
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
    ...testLifecycle,
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
    ...testLifecycle,
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
    ...testLifecycle,
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

function cleanupFixture(overrides: Partial<ApplicationPreviewServiceDependencies> = {}) {
  const id = "81234567-89ab-4def-8123-456789abcdef";
  const branchRef = `pv${id.replaceAll("-", "").slice(0, 18)}`;
  const receipt: StoredApplicationPreview = {
    ...buildApplicationPreviewReceipt({
      previewId: id, projectRef: "demo", applicationId: "api", environmentId: "test",
      releaseId: "a".repeat(64), branchRef, dataMode: "schema_only", expiresAt: "2026-10-11T00:00:00.000Z",
    }),
    status: "failed", branch_name: "fixture", queue_name: `preview_${id.replaceAll("-", "")}`,
    test_secret_name: `PREVIEW_TOKEN_${id.replaceAll("-", "").toUpperCase()}`, source_configuration_id: null,
    created_at: "2026-10-10T00:00:00.000Z", updated_at: "2026-10-10T00:00:00.000Z",
  };
  const configs: Record<string, unknown>[] = [{ application_previews: [receipt], owner_setting: "retained" }];
  const calls: string[] = [];
  let queue = true;
  const dependencies: ApplicationPreviewServiceDependencies = {
    ...testLifecycle, releases: releases(), projects: previewStore(configs),
    now: () => Date.parse("2026-10-12T00:00:00.000Z"),
    branches: { createBranch: async () => { calls.push("create"); }, deleteBranch: async () => { calls.push("branch"); } },
    queues: {
      createQueue: async () => {}, listQueues: async () => queue ? [{ queue_name: receipt.queue_name } as never] : [],
      dropQueue: async () => { calls.push("queue"); queue = false; return true; },
    },
    secrets: { upsertSecrets: async () => true, deleteSecret: async () => { calls.push("secret"); return true; } },
    invalidateEnv: async () => { calls.push("invalidate"); return true; },
    cleanupChecks: {
      assertSafe: async () => { calls.push("guard"); },
      cleanupStorage: async () => { calls.push("storage"); },
      verifySecretDeleted: async () => { calls.push("verify-secret"); },
      verifyBranchDeleted: async () => { calls.push("verify-branch"); },
    },
    ...overrides,
  };
  return { receipt, configs, calls, dependencies, service: new ApplicationPreviewService(dependencies) };
}

test("preview TTL is platform-owned, bounded and validated before materialization", async () => {
  const now = Date.parse("2026-10-11T00:00:00.000Z");
  const f = provisioningFixture({ now: () => now });
  for (const ttlSeconds of [undefined, 300, 604800]) {
    const created = await f.service.create({
      projectRef: "demo", applicationId: "api", environmentId: "test", releaseId: "a".repeat(64), ttlSeconds,
    });
    expect(created.created_at).toBe(new Date(now).toISOString());
    expect(created.expires_at).toBe(new Date(now + (ttlSeconds ?? 86400) * 1000).toISOString());
    await f.service.get("demo", created.preview_id);
  }
  let materialized = false;
  const invalid = provisioningFixture({ releases: {
    readRelease: async () => { materialized = true; throw new Error("must not read"); },
    materializeRelease: async () => { throw new Error("must not materialize"); },
  } });
  for (const ttlSeconds of [0, 299, 604801, 300.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await expect(invalid.service.create({
      projectRef: "demo", applicationId: "api", environmentId: "test", releaseId: "a".repeat(64), ttlSeconds,
    })).rejects.toThrow("APPLICATION_PREVIEW_TTL_INVALID");
  }
  expect(materialized).toBe(false);
});

test("cleanup checkpoints every confirmed resource and leaves earlier failures retryable", async () => {
  const f = cleanupFixture();
  let fail = true;
  const service = new ApplicationPreviewService({
    ...f.dependencies,
    cleanupChecks: { ...f.dependencies.cleanupChecks!,
      cleanupStorage: async () => { f.calls.push("storage"); if (fail) throw new Error("provider-private-credential"); } },
  });
  const first = await service.cleanup("demo", f.receipt.preview_id);
  expect(first).toMatchObject({
    status: "failed", cleanup: { required: true, completed: false, error: "APPLICATION_PREVIEW_CLEANUP_FAILED" },
    resources: { queue_namespace: { status: "cleaned" }, test_secret: { status: "cleaned" } },
  });
  expect(f.calls).not.toContain("branch");
  expect(JSON.stringify(first)).not.toContain("provider-private-credential");
  fail = false;
  const cleaned = await service.cleanup("demo", f.receipt.preview_id);
  expect(cleaned).toMatchObject({ status: "cleaned", cleanup: { required: false, completed: true, error: null } });
  expect(f.calls.filter(call => call === "queue")).toHaveLength(1);
  expect(f.calls.filter(call => call === "secret")).toHaveLength(1);
  expect(f.calls.slice(-4)).toEqual(["guard", "storage", "branch", "verify-branch"]);
  expect(f.configs[0]?.owner_setting).toBe("retained");
});

test("queue, Secret, invalidation and branch readback failures never become cleaned", async () => {
  const failures: Array<(f: ReturnType<typeof cleanupFixture>) => Partial<ApplicationPreviewServiceDependencies>> = [
    f => ({ queues: { ...f.dependencies.queues!, dropQueue: async () => false } }),
    f => ({ secrets: { ...f.dependencies.secrets!, deleteSecret: async () => false } }),
    () => ({ invalidateEnv: async () => false }),
    f => ({ cleanupChecks: { ...f.dependencies.cleanupChecks!,
      verifySecretDeleted: async () => { throw new Error("secret remains"); } } }),
    f => ({ cleanupChecks: { ...f.dependencies.cleanupChecks!,
      verifyBranchDeleted: async () => { throw new Error("database remains"); } } }),
  ];
  for (const change of failures) {
    const f = cleanupFixture();
    const service = new ApplicationPreviewService({ ...f.dependencies, ...change(f) });
    const receipt = await service.cleanup("demo", f.receipt.preview_id);
    expect(receipt?.status).toBe("failed");
    expect(receipt?.cleanup.completed).toBe(false);
    expect(receipt?.cleanup.required).toBe(true);
    expect(receipt?.resources.database_branch.status).not.toBe("cleaned");
  }
});

test("missing verifier, foreign ownership and CAS failure cannot trigger deletion", async () => {
  for (const kind of ["missing", "foreign", "cas"]) {
    const f = cleanupFixture();
    if (kind === "foreign") {
      const stored = f.configs[0]?.application_previews as StoredApplicationPreview[];
      stored[0]!.resources.database_branch.branch_ref = "production";
    }
    const service = new ApplicationPreviewService({
      ...f.dependencies,
      ...(kind === "missing" ? { cleanupChecks: undefined } : {}),
      ...(kind === "cas" ? { projects: { ...f.dependencies.projects!,
        saveApplicationPreview: async () => { throw new ApplicationPreviewConflictError(); } } } : {}),
    });
    if (kind === "cas") {
      await expect(service.cleanup("demo", f.receipt.preview_id)).rejects.toBeInstanceOf(ApplicationPreviewConflictError);
    } else {
      expect((await service.cleanup("demo", f.receipt.preview_id))?.cleanup.completed).toBe(false);
    }
    expect(f.calls.filter(call => call !== "guard")).toEqual([]);
  }
});

test("cleanup commits intent before deactivation and cannot stop an application after a CAS conflict", async () => {
  for (const conflict of [false, true]) {
    const f = cleanupFixture();
    const stored = (f.configs[0]?.application_previews as StoredApplicationPreview[])[0]!;
    stored.resources.application_activation = { status: "ready", activation_id: runtimeInput().activationId };
    const service = new ApplicationPreviewService({
      ...f.dependencies,
      projects: conflict ? {
        ...f.dependencies.projects!,
        saveApplicationPreview: async () => { throw new ApplicationPreviewConflictError(); },
      } : f.dependencies.projects,
      cleanupChecks: {
        ...f.dependencies.cleanupChecks!,
        deactivateApplication: async () => {
          const intent = (f.configs[0]?.application_previews as StoredApplicationPreview[])[0]!;
          expect(intent.cleanup.error).toBe("APPLICATION_PREVIEW_CLEANUP_PENDING");
          expect(intent.status).toBe("failed");
          f.calls.push("deactivate");
        },
      },
    });
    if (conflict) {
      await expect(service.cleanup("demo", stored.preview_id)).rejects.toBeInstanceOf(ApplicationPreviewConflictError);
      expect(f.calls).toEqual(["guard"]);
    } else {
      expect((await service.cleanup("demo", stored.preview_id))?.status).toBe("cleaned");
      expect(f.calls.slice(0, 3)).toEqual(["guard", "deactivate", "queue"]);
    }
  }
});

test("cleanup reads never resume provisioning and automatic cleanup rechecks the persisted deadline", async () => {
  const f = cleanupFixture();
  const stored = (f.configs[0]?.application_previews as StoredApplicationPreview[])[0]!;
  stored.status = "provisioning";
  stored.expires_at = "2026-10-13T00:00:00.000Z";
  expect((await f.service.cleanup("demo", stored.preview_id, { automatic: true }))?.status).toBe("provisioning");
  expect(f.calls).toEqual([]);
  stored.expires_at = null;
  await f.service.cleanup("demo", stored.preview_id, { automatic: true });
  expect(f.calls).toEqual([]);
  stored.expires_at = "2026-10-11T00:00:00.000Z";
  expect((await f.service.cleanup("demo", stored.preview_id, { automatic: true }))?.status).toBe("cleaned");
  expect(f.calls).not.toContain("create");
  expect((await f.service.get("demo", stored.preview_id))?.status).toBe("cleaned");
});

test("the maintenance sweep is bounded, scope checked and continues after an individual failure", async () => {
  const f = cleanupFixture();
  const secondId = "91234567-89ab-4def-8123-456789abcdef";
  const attempted: string[] = [];
  const result = await runApplicationPreviewCleanupSweep({
    now: Date.parse("2026-10-12T00:00:00.000Z"),
    discover: async (cursor, limit) => {
      expect(cursor).toBeNull();
      expect(limit).toBe(16);
      return [
        { projectRef: "demo", preview: { ...f.receipt, expires_at: null } },
        { projectRef: "demo", preview: { ...f.receipt, expires_at: "2026-10-13T00:00:00.000Z" } },
        { projectRef: "other", preview: f.receipt },
        { projectRef: "demo", preview: { ...f.receipt, expires_at: "broken" } },
        { projectRef: "demo", preview: f.receipt },
        { projectRef: "demo", preview: { ...f.receipt, preview_id: secondId } },
      ];
    },
    previews: { cleanup: async (ref, id, options) => {
      expect(ref).toBe("demo");
      expect(options).toEqual({ automatic: true });
      attempted.push(id);
      if (id === f.receipt.preview_id) throw new Error("private-provider-credential");
      return { ...f.receipt, preview_id: id, status: "cleaned", cleanup: { required: false, completed: true, error: null } };
    } },
  });
  expect(result).toEqual({
    checked: 6, attempted: 2, cleaned: 1, pending: 1, skipped: 4,
    cursor: { projectRef: "demo", previewId: secondId },
  });
  expect(attempted).toEqual([f.receipt.preview_id, secondId]);
  const empty = await runApplicationPreviewCleanupSweep({
    previews: f.service, cursor: result.cursor, discover: async cursor => { expect(cursor).toEqual(result.cursor); return []; },
  });
  expect(empty.cursor).toBeNull();
});

test("automatic cleanup blocks active and uncertain activations before deactivation or resource deletion", async () => {
  const f = cleanupFixture();
  const runtime = runtimeInput();
  let effects = 0;
  const current: ApplicationActiveRecord = {
    schema: "supacloud.application-active.v1", runtime, configurationId, configurationDigest: "b".repeat(64), hosts: { api: ["app.test"] },
  };
  const checks = createApplicationPreviewCleanupChecks(
    { readForApplication: async () => current },
    { deactivateConfigured: async () => { effects++; throw new Error("must not deactivate"); } },
    { projects: { findByRef: async () => null }, runtimeOccupied: async () => false },
  );
  await expect(checks.assertSafe(f.receipt, true)).rejects.toThrow("APPLICATION_PREVIEW_CLEANUP_ACTIVE");
  const uncertain = structuredClone(f.receipt);
  uncertain.resources.application_activation = { status: "pending", activation_id: runtime.activationId };
  const absent = createApplicationPreviewCleanupChecks(
    { readForApplication: async () => null },
    { deactivateConfigured: async () => { effects++; throw new Error("must not deactivate"); } },
    { projects: { findByRef: async () => null }, runtimeOccupied: async () => false },
  );
  await expect(absent.assertSafe(uncertain, false)).rejects.toThrow("APPLICATION_PREVIEW_CLEANUP_ACTIVATION_UNRESOLVED");
  expect(effects).toBe(0);
});

test("explicit cleanup admission is read-only and deactivation verifies remaining occupancy", async () => {
  const f = cleanupFixture();
  const runtime = runtimeInput();
  f.receipt.resources.application_activation = { status: "ready", activation_id: runtime.activationId };
  f.receipt.resources.configuration_revision = { status: "ready", configuration_id: configurationId };
  const current: ApplicationActiveRecord = {
    schema: "supacloud.application-active.v1",
    runtime: { ...runtime, release: { ...runtime.release,
      project_ref: f.receipt.resources.database_branch.branch_ref, release_id: f.receipt.release_id } },
    configurationId, configurationDigest: "b".repeat(64), hosts: { api: ["app.test"] },
  };
  let effects = 0;
  const checks = createApplicationPreviewCleanupChecks(
    { readForApplication: async () => current },
    { deactivateConfigured: async () => {
      effects++;
      return { project_ref: current.runtime.release.project_ref, application_id: f.receipt.application_id,
        environment_id: f.receipt.environment_id, activation_id: runtime.activationId,
        mutation_id: f.receipt.preview_id, deactivated: true };
    } },
    { projects: { findByRef: async () => null }, runtimeOccupied: async () => true },
  );
  await checks.assertSafe(f.receipt, false);
  expect(effects).toBe(0);
  await expect(checks.deactivateApplication!(f.receipt)).rejects.toThrow("APPLICATION_PREVIEW_CLEANUP_ACTIVATION_UNRESOLVED");
  expect(effects).toBe(1);
});

test("Storage cleanup removes only an empty owned root and refuses objects or symlinks", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "preview-cleanup-storage-")));
  const branchRef = "pv8123456789ab4def81";
  const directory = join(root, resolveBucketName(branchRef));
  try {
    await mkdir(directory);
    await cleanupEmptyPreviewStorage(branchRef, root);
    await expect(realpath(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await cleanupEmptyPreviewStorage(branchRef, root);
    await mkdir(directory);
    await Bun.write(join(directory, "retained.txt"), "retained");
    await expect(cleanupEmptyPreviewStorage(branchRef, root)).rejects.toThrow("APPLICATION_PREVIEW_CLEANUP_STORAGE_OCCUPIED");
    expect(await Bun.file(join(directory, "retained.txt")).text()).toBe("retained");
    await rm(directory, { recursive: true });
    const outside = join(root, "outside");
    await mkdir(outside);
    await Bun.write(join(outside, "retained.txt"), "outside");
    await symlink(outside, directory);
    await expect(cleanupEmptyPreviewStorage(branchRef, root)).rejects.toThrow("APPLICATION_PREVIEW_CLEANUP_STORAGE_UNSUPPORTED");
    expect(await Bun.file(join(outside, "retained.txt")).text()).toBe("outside");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function deactivationFixture() {
  const root = await mkdtemp(join(tmpdir(), "preview-deactivation-"));
  const active = new ApplicationActiveStorage(join(root, "authority"));
  const runtime = runtimeInput();
  const hosts = { api: ["app.example.test"] };
  const record: ApplicationActiveRecord = {
    schema: "supacloud.application-active.v1", runtime, hosts, configurationId, configurationDigest: "b".repeat(64),
  };
  await active.write(record, null);
  const { journal, states } = activationJournal();
  const calls: string[] = [];
  let stopped = false;
  let routed = true;
  let allocation: ApplicationRuntimeAllocation = {
    schema: "supacloud.application-runtime-allocation.v1", runtime, configurationId, createdAt: new Date().toISOString(),
  };
  const dependencies: ApplicationDeploymentDependencies = {
    active, mutations: journal, verifyCompatibility: async () => {},
    withProjectLifecycle: async (_ref, operation) => { calls.push("lock"); return operation(); },
    configurations: { resolve: async () => ({ bunVersion: "1.4.2", hosts, environment: { api: {}, jobs: {} } }) },
    allocations: {
      allocate: async () => { throw new Error("must not allocate"); },
      read: async () => structuredClone(allocation),
      retire: async (_ref, _id, verify) => {
        await verify(allocation);
        calls.push("retire");
        allocation = { ...allocation, retiredAt: new Date().toISOString() };
        return structuredClone(allocation);
      },
    },
    runtime: {
      install: async () => { throw new Error("must not install"); },
      start: async () => { throw new Error("must not start"); },
      stop: async () => { calls.push("stop"); stopped = true; return []; },
      requireStopped: async () => { if (!stopped) throw new Error("still running"); return []; },
    },
    gateway: {
      configureApplicationRoute: async () => { throw new Error("must not route"); },
      verifyApplicationRoute: async () => { throw new Error("must not probe readiness"); },
      removeApplicationRoute: async () => { calls.push("unroute"); routed = false; },
      verifyApplicationRouteAbsent: async () => { if (routed) throw new Error("still routed"); },
    },
  };
  const input = {
    projectRef: runtime.release.project_ref, applicationId: runtime.release.application_id, environmentId: runtime.environmentId,
    activationId: runtime.activationId, mutationId: "81234567-89ab-4def-8123-456789abcdef",
    principal: { type: "master" as const, id: "preview-cleanup" },
  };
  return { root, active, dependencies, journal, states, calls, input, runtime };
}

test("explicit deactivation preserves former authority and retires only the selected activation", async () => {
  const f = await deactivationFixture();
  try {
    const service = new ApplicationDeploymentService(f.dependencies);
    expect(await service.deactivateConfigured(f.input)).toMatchObject({ deactivated: true, activation_id: f.input.activationId });
    expect(f.calls).toEqual(["lock", "stop", "unroute", "retire"]);
    expect(await f.active.read(f.runtime)).toBeNull();
    const archived = Bun.file(join(f.root, "authority", f.input.projectRef, f.input.applicationId, f.input.environmentId,
      `deactivated-${f.input.activationId}.json`));
    expect((await archived.json()).runtime.activationId).toBe(f.input.activationId);
    expect(f.states.get(f.input.mutationId)?.status).toBe("succeeded");
    f.calls.length = 0;
    await service.deactivateConfigured(f.input);
    expect(f.calls).toEqual(["lock"]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("deactivation cannot stop a newer activation or resume unknown partial effects", async () => {
  const f = await deactivationFixture();
  try {
    const service = new ApplicationDeploymentService(f.dependencies);
    await expect(service.deactivateConfigured({ ...f.input, applicationId: "different" })).rejects.toThrow("IDENTITY_INVALID");
    expect(f.calls).toEqual(["lock"]);
    f.calls.length = 0;
    f.dependencies.gateway!.removeApplicationRoute = async () => { throw new Error("provider response lost"); };
    await expect(new ApplicationDeploymentService(f.dependencies).deactivateConfigured(f.input)).rejects.toThrow("provider response lost");
    expect(f.states.get(f.input.mutationId)?.status).toBe("outcome_unknown");
    const calls = [...f.calls];
    await expect(new ApplicationDeploymentService(f.dependencies).deactivateConfigured(f.input)).rejects.toThrow("RECONCILIATION_REQUIRED");
    expect(f.calls).toEqual([...calls, "lock"]);
    expect(await f.active.read(f.runtime)).not.toBeNull();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("a lost final deactivation receipt is reconciled observationally without replaying effects", async () => {
  const f = await deactivationFixture();
  try {
    f.journal.success = async () => { throw new Error("receipt response lost"); };
    await expect(new ApplicationDeploymentService(f.dependencies).deactivateConfigured(f.input)).rejects.toThrow("receipt response lost");
    expect(f.states.get(f.input.mutationId)?.status).toBe("outcome_unknown");
    f.calls.length = 0;
    await new ApplicationDeploymentService(f.dependencies).deactivateConfigured(f.input);
    expect(f.calls).toEqual(["lock"]);
    expect(f.states.get(f.input.mutationId)?.status).toBe("succeeded");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("active clear refuses a newer authority and repairs directory durability after a lost response", async () => {
  const f = await deactivationFixture();
  try {
    const wrongId = "71234567-89ab-4def-8123-456789abcdef";
    await expect(f.active.clear(f.runtime, wrongId)).rejects.toThrow("APPLICATION_ACTIVATION_REVISION_CONFLICT");
    expect((await f.active.read(f.runtime))?.runtime.activationId).toBe(f.runtime.activationId);
    let failSync = true;
    let syncs = 0;
    const storage = new ApplicationActiveStorage(join(f.root, "authority"), {
      beforeDirectorySync: async () => {
        syncs++;
        if (failSync) throw new Error("directory sync failed");
      },
    });
    await expect(storage.clear(f.runtime, f.runtime.activationId)).rejects.toThrow("directory sync failed");
    expect(await storage.read(f.runtime)).toBeNull();
    const archive = Bun.file(join(f.root, "authority", f.input.projectRef, f.input.applicationId, f.input.environmentId,
      `deactivated-${f.runtime.activationId}.json`));
    const archived = await archive.text();
    failSync = false;
    await storage.clear(f.runtime, f.runtime.activationId);
    expect(syncs).toBeGreaterThan(1);
    expect(await archive.text()).toBe(archived);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
