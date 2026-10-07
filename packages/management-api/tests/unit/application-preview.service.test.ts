import { expect, test } from "bun:test";
import { ApplicationPreviewService } from "../../src/services/application-preview.service";

function project(config: Record<string, unknown> = {}) {
  return { config, ref: "demo" } as never;
}

test("preview provisioning reaches ready only after all isolated resources and smoke pass", async () => {
  const configs: Record<string, unknown>[] = [{}];
  const calls: string[] = [];
  const service = new ApplicationPreviewService({
    releases: { readRelease: async () => ({ release_id: "a".repeat(64) } as never) },
    projects: {
      findByRef: async () => project(configs[0]),
      updateConfig: async (_ref, config) => { configs[0] = config; return project(config); },
    },
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
  expect(receipts[0]).toMatchObject({
    status: "ready",
    resources: { smoke_test: { status: "ready", failed: [] } },
  });
  expect(calls).toEqual(["branch:create", "queue:create", "secret:create"]);
});

test("preview cleanup is explicit and idempotent at the receipt boundary", async () => {
  const configs: Record<string, unknown>[] = [{}];
  const calls: string[] = [];
  const service = new ApplicationPreviewService({
    releases: { readRelease: async () => ({ release_id: "b".repeat(64) } as never) },
    projects: {
      findByRef: async () => project(configs[0]),
      updateConfig: async (_ref, config) => { configs[0] = config; return project(config); },
    },
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
  expect(calls).toEqual(["queue:drop", "secret:delete", "branch:delete"]);
});

test("preview reads resume a persisted provisioning receipt without recreating its branch", async () => {
  const previewId = "12345678-1234-4234-8234-123456789abc";
  const branchRef = "pv123456781234423482";
  const configs: Record<string, unknown>[] = [{
    application_previews: [{
      schema: "supacloud.application-preview.v1",
      preview_id: previewId,
      project_ref: "demo",
      application_id: "api",
      environment_id: "test",
      release_id: "c".repeat(64),
      status: "provisioning",
      branch_name: "existing-preview",
      queue_name: "preview_123456781234423482",
      test_secret_name: "PREVIEW_TOKEN_123456781234423482",
      created_at: "2026-10-07T00:00:00.000Z",
      updated_at: "2026-10-07T00:00:00.000Z",
      resources: {
        build_artifact: { status: "ready", release_id: "c".repeat(64) },
        database_branch: { status: "ready", branch_ref: branchRef, data_mode: "schema_only" },
        queue_namespace: { status: "pending", namespace: "preview_123456781234423482" },
        storage_namespace: { status: "pending", namespace: branchRef },
        test_secret: { status: "pending", name: "PREVIEW_TOKEN_123456781234423482", value_issued: false },
        smoke_test: {
          status: "pending",
          checks: ["release_artifact", "database_branch", "queue_namespace", "storage_namespace", "test_secret", "application_readiness"],
          passed: [],
          failed: [],
        },
      },
      cleanup: { required: true, completed: false, error: null },
    }],
  }];
  const calls: string[] = [];
  const service = new ApplicationPreviewService({
    releases: { readRelease: async () => ({ release_id: "c".repeat(64) } as never) },
    projects: {
      findByRef: async ref => ref === branchRef
        ? ({ ref: branchRef, config: { parent_ref: "demo" } } as never)
        : project(configs[0]),
      updateConfig: async (_ref, config) => { configs[0] = config; return project(config); },
    },
    branches: {
      createBranch: async () => { calls.push("branch:create"); },
      deleteBranch: async () => {},
    },
    queues: {
      createQueue: async () => { calls.push("queue:create"); },
      dropQueue: async () => true,
      listQueues: async () => [],
    },
    secrets: {
      upsertSecrets: async () => { calls.push("secret:create"); return true; },
      deleteSecret: async () => true,
    },
    invalidateEnv: async () => true,
    runtime: { checkStatus: async () => ({ status: "running", health: "healthy" } as never) },
    smokeTest: async () => ({ passed: ["application_readiness"], failed: [] }),
  });

  const receipt = await service.get("demo", previewId);
  expect(receipt).toMatchObject({ status: "ready" });
  expect(calls).toEqual(["queue:create", "secret:create"]);
});
