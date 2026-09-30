import { expect, test } from "bun:test";
import { composePreviewEnvironment } from "../../src/services/preview-environment.service";
import {
  createPreviewDatabasePort,
  createPreviewQueuePort,
  createPreviewStoragePort,
  provisionPreviewEnvironment,
  reclaimDuePreviews,
  reclaimPreviewEnvironment,
  type PreviewProvisioningPorts,
  type StoredPreviewEnvironment,
} from "../../src/services/preview-provisioning.service";

const input = {
  previewRef: "pr-42",
  projectRef: "demo",
  applicationId: "reviews",
  environmentId: "preview",
  releaseId: "a".repeat(64),
  source: { branch: "feature/orders", commit: "b".repeat(40) },
};

function ports(overrides: Partial<PreviewProvisioningPorts> = {}) {
  const calls: string[] = [];
  const base: PreviewProvisioningPorts = {
    database: {
      create: async () => { calls.push("database.create"); },
      delete: async () => { calls.push("database.delete"); },
    },
    application: { activate: async () => { calls.push("application.activate"); } },
    configuration: { bind: async () => { calls.push("configuration.bind"); } },
    resources: { bind: async () => { calls.push("resources.bind"); } },
    queues: {
      create: async () => { calls.push("queues.create"); },
      delete: async () => { calls.push("queues.delete"); },
    },
    storage: {
      create: async () => { calls.push("storage.create"); },
      delete: async () => { calls.push("storage.delete"); },
    },
    secrets: { bind: async () => { calls.push("secrets.bind"); } },
    isolation: { verify: async () => true },
  };
  return { calls, ports: { ...base, ...overrides } };
}

test("provisions every component in order and verifies isolation", async () => {
  const { calls, ports: fake } = ports();
  const result = await provisionPreviewEnvironment(fake, input);
  expect(result.status).toBe("ready");
  expect(result.preview.components.every((component) => component.status === "ready")).toBe(true);
  expect(result.preview.isolation.every((check) => check.status === "verified")).toBe(true);
  expect(calls).toEqual([
    "database.create", "application.activate", "configuration.bind", "resources.bind",
    "queues.create", "storage.create", "secrets.bind",
  ]);
});

test("fails closed on the first failing component without verifying isolation", async () => {
  const { calls, ports: fake } = ports({
    queues: { create: async () => { throw new Error("queue backend unavailable"); }, delete: async () => {} },
    isolation: { verify: async () => { calls.push("isolation.verify"); return true; } },
  });
  const result = await provisionPreviewEnvironment(fake, input);
  expect(result.status).toBe("failed");
  expect(result.failed_component).toBe("queues");
  expect(result.error).toBe("queue backend unavailable");
  expect(result.preview.components.find((component) => component.name === "queues")?.status).toBe("failed");
  expect(result.preview.isolation.every((check) => check.status === "pending")).toBe(true);
  expect(calls).not.toContain("storage.create");
  expect(calls).not.toContain("isolation.verify");
});

test("is not ready while any isolation check fails", async () => {
  const { ports: fake } = ports({
    isolation: { verify: async (check) => check !== "storage_permissions" },
  });
  const result = await provisionPreviewEnvironment(fake, input);
  expect(result.status).toBe("failed");
  expect(result.preview.isolation.map((check) => check.status)).toEqual(["verified", "failed", "verified", "verified"]);
});

test("reclaims namespace components before the database and reports failures", async () => {
  const { calls, ports: fake } = ports({
    queues: { create: async () => {}, delete: async () => { calls.push("queues.delete"); throw new Error("queue busy"); } },
  });
  const preview = composePreviewEnvironment(input);
  const result = await reclaimPreviewEnvironment(fake, preview);
  expect(calls).toEqual(["storage.delete", "queues.delete", "database.delete"]);
  expect(result.released).toEqual(["storage", "database"]);
  expect(result.failed).toEqual([{ component: "queues", error: "queue busy" }]);
});

test("reclaims only timeout-due previews", async () => {
  const now = new Date("2026-09-30T12:00:00.000Z");
  const stored: StoredPreviewEnvironment[] = [
    { preview: composePreviewEnvironment({ ...input, previewRef: "expired", lifecycle: { reclaimOn: "timeout", timeoutHours: 24 } }), created_at: "2026-09-20T00:00:00.000Z" },
    { preview: composePreviewEnvironment({ ...input, previewRef: "fresh", lifecycle: { reclaimOn: "timeout", timeoutHours: 24 } }), created_at: "2026-09-30T00:00:00.000Z" },
    { preview: composePreviewEnvironment({ ...input, previewRef: "by-pr" }), created_at: "2026-09-01T00:00:00.000Z" },
  ];
  const { calls, ports: fake } = ports();
  const results = await reclaimDuePreviews(fake, stored, now);
  expect(results.map((result) => result.preview_ref)).toEqual(["expired"]);
  expect(calls.filter((call) => call.endsWith(".delete"))).toHaveLength(3);
});
test("database port adapts the existing branch service", async () => {
  const seen: Array<[string, string]> = [];
  const database = createPreviewDatabasePort({
    createBranch: async (value) => { seen.push(["create", value.name]); },
    deleteBranch: async (branchRef) => { seen.push(["delete", branchRef]); },
  });
  const preview = composePreviewEnvironment(input);
  await database.database.create(preview);
  await database.database.delete(preview);
  expect(seen).toEqual([["create", "preview-pr-42"], ["delete", "preview-pr-42"]]);
});

test("queue port namespaces and drops each preview queue", async () => {
  const seen: string[] = [];
  const queues = createPreviewQueuePort({
    createQueue: async (ref, queue) => { seen.push(`create:${ref}:${queue}`); },
    dropQueue: async (ref, queue) => { seen.push(`drop:${ref}:${queue}`); },
  });
  const preview = composePreviewEnvironment({ ...input, queueNames: ["orders", "audit"] });
  await queues.queues.create(preview);
  await queues.queues.delete(preview);
  expect(seen).toEqual([
    "create:demo:preview_pr_42__audit", "create:demo:preview_pr_42__orders",
    "drop:demo:preview_pr_42__audit", "drop:demo:preview_pr_42__orders",
  ]);
});

test("storage port namespaces and deletes each preview bucket", async () => {
  const seen: string[] = [];
  const storage = createPreviewStoragePort({
    createBucket: async (ref, bucket) => { seen.push(`create:${ref}:${bucket}`); },
    deleteBucket: async (ref, bucket) => { seen.push(`delete:${ref}:${bucket}`); },
  });
  const preview = composePreviewEnvironment({ ...input, storageBuckets: ["uploads", "reports"] });
  await storage.storage.create(preview);
  await storage.storage.delete(preview);
  expect(seen).toEqual([
    "create:demo:preview-pr-42-reports", "create:demo:preview-pr-42-uploads",
    "delete:demo:preview-pr-42-reports", "delete:demo:preview-pr-42-uploads",
  ]);
});
