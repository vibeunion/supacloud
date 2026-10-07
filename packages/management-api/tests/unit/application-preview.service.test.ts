import { expect, test } from "bun:test";
import { ApplicationPreviewService } from "../../src/services/application-preview.service";
import type { StoredApplicationPreview } from "../../src/services/application-preview-contract";
import { ApplicationPreviewConflictError } from "../../src/repositories/project-config-writes";

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
    releases: { readRelease: async () => ({ release_id: "a".repeat(64) } as never) },
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
  await new Promise(resolve => setTimeout(resolve, 0));
  const receipts = await service.list("demo", "api", "test");
  expect(receipts[0]).toMatchObject({ status: "ready", resources: { smoke_test: { status: "ready", failed: [] } } });
  expect(calls).toEqual(["branch:create", "queue:create", "secret:create"]);
});

test("preview cleanup is explicit and idempotent at the receipt boundary", async () => {
  const configs: Record<string, unknown>[] = [{}];
  const calls: string[] = [];
  const service = new ApplicationPreviewService({
    releases: { readRelease: async () => ({ release_id: "b".repeat(64) } as never) },
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
  await new Promise(resolve => setTimeout(resolve, 0));
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
    releases: { readRelease: async () => ({ release_id: "c".repeat(64) } as never) },
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
    releases: { readRelease: async () => ({ release_id: "d".repeat(64) } as never) },
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
    releases: { readRelease: async () => ({ release_id: "e".repeat(64) } as never) },
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
