import { expect, test } from "bun:test";
import { composePreviewEnvironment, type PreviewEnvironment } from "../../src/services/preview-environment.service";
import type { PreviewProvisioningPorts, StoredPreviewEnvironment } from "../../src/services/preview-provisioning.service";
import {
  closePreview,
  createBranchPreviewStore,
  createProjectConfigPreviewStore,
  markPreviewClosed,
  reclaimStoredPreviews,
  savePreview,
  type PreviewStore,
} from "../../src/services/preview-lifecycle.service";

const input = {
  previewRef: "pr-42",
  projectRef: "demo",
  applicationId: "reviews",
  environmentId: "preview",
  releaseId: "a".repeat(64),
  source: { branch: "feature/orders", commit: "b".repeat(40) },
};

function preview(overrides: Partial<typeof input> = {}): PreviewEnvironment {
  return composePreviewEnvironment({ ...input, ...overrides });
}

function readyPreview(overrides: Partial<typeof input> = {}): PreviewEnvironment {
  const composed = preview(overrides);
  return { ...composed, components: composed.components.map((component) => ({ ...component, status: "ready" as const })) };
}

function memoryStore(initial: StoredPreviewEnvironment[] = []) {
  const data = new Map<string, StoredPreviewEnvironment[]>(initial.length ? [["demo", [...initial]]] : []);
  return {
    data,
    store: {
      list: async (projectRef) => [...(data.get(projectRef) ?? [])],
      save: async (projectRef, item) => {
        data.set(projectRef, [...(data.get(projectRef) ?? []).filter((entry) => entry.preview.preview_ref !== item.preview.preview_ref), item]);
      },
      remove: async (projectRef, previewRef) => {
        data.set(projectRef, (data.get(projectRef) ?? []).filter((entry) => entry.preview.preview_ref !== previewRef));
      },
    } satisfies PreviewStore,
  };
}

function ports(failDelete = false): Pick<PreviewProvisioningPorts, "database" | "queues" | "storage"> {
  const run = async () => { if (failDelete) throw new Error("busy"); };
  return {
    database: { create: run, delete: run },
    queues: { create: run, delete: run },
    storage: { create: run, delete: run },
  };
}

test("saves a preview with its creation timestamp", async () => {
  const now = new Date("2026-09-30T12:00:00.000Z");
  const { store } = memoryStore();
  const stored = await savePreview(store, "demo", preview(), now);
  expect(stored.created_at).toBe("2026-09-30T12:00:00.000Z");
  expect((await store.list("demo"))[0]?.preview.preview_ref).toBe("pr-42");
});

test("reclaims only due previews and removes their records", async () => {
  const now = new Date("2026-09-30T12:00:00.000Z");
  const { store } = memoryStore([
    { preview: preview({ previewRef: "pr-1", lifecycle: { reclaimOn: "timeout", timeoutHours: 24 } }), created_at: "2026-09-20T00:00:00.000Z" },
    { preview: preview({ previewRef: "pr-2", lifecycle: { reclaimOn: "timeout", timeoutHours: 24 } }), created_at: "2026-09-30T00:00:00.000Z" },
    { preview: preview({ previewRef: "pr-3", lifecycle: { reclaimOn: "pr_closed" } }), created_at: "2026-09-01T00:00:00.000Z", closed_at: "2026-09-15T00:00:00.000Z" },
  ]);
  const report = await reclaimStoredPreviews(store, ports(), "demo", now);
  expect(report).toEqual({ checked: 3, reclaimed: 2, failed: [] });
  expect((await store.list("demo")).map((entry) => entry.preview.preview_ref)).toEqual(["pr-2"]);
});

test("marks a preview closed so the next pass reclaims it", async () => {
  const { store } = memoryStore([
    { preview: preview({ lifecycle: { reclaimOn: "pr_closed" } }), created_at: "2026-09-01T00:00:00.000Z" },
  ]);
  expect(await markPreviewClosed(store, "demo", "missing", new Date("2026-09-30T00:00:00.000Z"))).toBeNull();
  const closed = await markPreviewClosed(store, "demo", "pr-42", new Date("2026-09-30T00:00:00.000Z"));
  expect(closed?.closed_at).toBe("2026-09-30T00:00:00.000Z");
  const report = await reclaimStoredPreviews(store, ports(), "demo", new Date("2026-09-30T00:00:01.000Z"));
  expect(report.reclaimed).toBe(1);
  expect(await store.list("demo")).toEqual([]);
});

test("keeps the record when a provisioned component has no release port", async () => {
  const now = new Date("2026-09-30T12:00:00.000Z");
  const { store } = memoryStore([
    { preview: readyPreview({ previewRef: "pr-1" }), created_at: "2026-09-01T00:00:00.000Z", closed_at: "2026-09-15T00:00:00.000Z" },
  ]);
  const report = await reclaimStoredPreviews(store, ports(), "demo", now);
  expect(report.reclaimed).toBe(0);
  expect(report.failed[0]?.preview_ref).toBe("pr-1");
  expect(await store.list("demo")).toHaveLength(1);

  const closed = await closePreview(store, ports(), "demo", "pr-1");
  expect(closed?.receipt.status).toBe("incomplete");
  expect(closed?.unreleased).toEqual(["application", "secrets", "configuration", "resources"]);
  expect(await store.list("demo")).toHaveLength(1);
});

test("keeps the record and residue when a release fails", async () => {
  const now = new Date("2026-09-30T12:00:00.000Z");
  const { store } = memoryStore([
    { preview: preview({ previewRef: "pr-1", lifecycle: { reclaimOn: "timeout", timeoutHours: 1 } }), created_at: "2026-09-01T00:00:00.000Z" },
  ]);
  const report = await reclaimStoredPreviews(store, ports(true), "demo", now);
  expect(report.reclaimed).toBe(0);
  expect(report.failed[0]?.preview_ref).toBe("pr-1");
  expect(report.failed[0]?.failed.map((entry) => entry.component)).toEqual(["storage", "queues", "database"]);
  expect(await store.list("demo")).toHaveLength(1);
});

test("closes one preview by reference", async () => {
  const { store } = memoryStore([{ preview: preview(), created_at: "2026-09-30T00:00:00.000Z" }]);
  expect(await closePreview(store, ports(), "demo", "missing")).toBeNull();
  const result = await closePreview(store, ports(), "demo", "pr-42");
  expect(result?.released).toEqual(["storage", "queues", "database"]);
  expect(await store.list("demo")).toEqual([]);
});

test("project-config store filters untrusted entries and upserts by reference", async () => {
  let config: Record<string, unknown> = { other: true, previews: [{ preview: { preview_ref: "bad" } }, "junk"] };
  const store = createProjectConfigPreviewStore({
    readConfig: async () => config,
    writeConfig: async (_ref, next) => { config = next; },
  });
  expect(await store.list("demo")).toEqual([]);

  await savePreview(store, "demo", preview(), new Date("2026-09-30T00:00:00.000Z"));
  await savePreview(store, "demo", preview({ previewRef: "pr-42" }), new Date("2026-09-30T01:00:00.000Z"));
  expect((config.previews as unknown[]).length).toBe(1);
  expect(config.other).toBe(true);

  await store.remove("demo", "pr-42");
  expect(await store.list("demo")).toEqual([]);
});

test("branch store keeps preview state on the existing branch records", async () => {
  let config: Record<string, unknown> = {
    branches: [{ ref: "pr-42", name: "feature/orders", parent_ref: "demo", status: "active", created_at: "2026-09-29T00:00:00.000Z" }],
  };
  const store = createBranchPreviewStore({
    readConfig: async () => config,
    writeConfig: async (_ref, next) => { config = next; },
  });

  await savePreview(store, "demo", preview(), new Date("2026-09-30T00:00:00.000Z"));
  expect(Object.hasOwn(config, "previews")).toBe(false);
  const branches = config.branches as Record<string, unknown>[];
  expect(branches).toHaveLength(1);
  expect(branches[0]?.name).toBe("feature/orders");
  expect((branches[0]?.preview as Record<string, unknown>).created_at).toBe("2026-09-30T00:00:00.000Z");
  expect(await store.list("demo")).toHaveLength(1);

  await markPreviewClosed(store, "demo", "pr-42", new Date("2026-09-30T01:00:00.000Z"));
  expect(await store.list("demo")).toEqual([{
    preview: preview(), created_at: "2026-09-30T00:00:00.000Z", closed_at: "2026-09-30T01:00:00.000Z",
  }]);

  await store.remove("demo", "pr-42");
  expect(await store.list("demo")).toEqual([]);
  const remaining = config.branches as Record<string, unknown>[];
  expect(remaining).toHaveLength(1);
  expect(remaining[0]?.ref).toBe("pr-42");
  expect(Object.hasOwn(remaining[0] ?? {}, "preview")).toBe(false);
});

test("branch store ignores branches without preview state and mismatched refs", async () => {
  let config: Record<string, unknown> = {
    branches: [
      { ref: "pr-1", name: "one", parent_ref: "demo", status: "active" },
      { ref: "pr-2", name: "two", parent_ref: "demo", status: "active", preview: { environment: { schema: "supacloud.preview-environment.v1", preview_ref: "other" }, created_at: "2026-09-30T00:00:00.000Z" } },
    ],
  };
  const store = createBranchPreviewStore({
    readConfig: async () => config,
    writeConfig: async (_ref, next) => { config = next; },
  });
  expect(await store.list("demo")).toEqual([]);
});