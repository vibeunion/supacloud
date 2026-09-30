import { expect, test } from "bun:test";
import { createPreviewLifecycleRoutes } from "../../src/routes/preview-lifecycle";
import { composePreviewEnvironment } from "../../src/services/preview-environment.service";
import type { PreviewProvisioningPorts, StoredPreviewEnvironment } from "../../src/services/preview-provisioning.service";
import type { PreviewStore } from "../../src/services/preview-lifecycle.service";

const input = {
  previewRef: "pr-1",
  projectRef: "demo",
  applicationId: "reviews",
  environmentId: "preview",
  releaseId: "a".repeat(64),
  source: { branch: "feature/orders", commit: "b".repeat(40) },
};

function memoryStore(initial: StoredPreviewEnvironment[]): PreviewStore {
  let data = [...initial];
  return {
    list: async () => [...data],
    save: async (_ref, item) => { data = [...data.filter((entry) => entry.preview.preview_ref !== item.preview.preview_ref), item]; },
    remove: async (_ref, previewRef) => { data = data.filter((entry) => entry.preview.preview_ref !== previewRef); },
  };
}

function ports(): Pick<PreviewProvisioningPorts, "database" | "queues" | "storage"> {
  const run = async () => {};
  return { database: { create: run, delete: run }, queues: { create: run, delete: run }, storage: { create: run, delete: run } };
}

function app(options: { ports?: ReturnType<typeof ports>; initial?: StoredPreviewEnvironment[] } = {}) {
  return createPreviewLifecycleRoutes({
    store: memoryStore(options.initial ?? []),
    ...(options.ports ? { ports: options.ports } : {}),
    authorize: async () => undefined,
    now: () => new Date("2026-09-30T12:00:00.000Z"),
  });
}

const url = "http://localhost/v1/projects/demo/previews";

test("lists tracked previews", async () => {
  const routes = app({ initial: [{ preview: composePreviewEnvironment(input), created_at: "2026-09-30T00:00:00.000Z" }] });
  const response = await routes.handle(new Request(url));
  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload.preview_ref ?? payload.project_ref).toBe("demo");
  expect(payload.previews[0].preview.preview_ref).toBe("pr-1");
});

test("answers 501 when reclamation ports are not configured", async () => {
  const routes = app({ initial: [{ preview: composePreviewEnvironment(input), created_at: "2026-09-30T00:00:00.000Z" }] });
  const close = await routes.handle(new Request(`${url}/pr-1`, { method: "DELETE" }));
  expect(close.status).toBe(501);
  expect((await close.json()).code).toBe("PREVIEW_RECLAMATION_UNAVAILABLE");
});

test("closes one preview and reports a missing one", async () => {
  const routes = app({ ports: ports(), initial: [{ preview: composePreviewEnvironment(input), created_at: "2026-09-30T00:00:00.000Z" }] });
  const missing = await routes.handle(new Request(`${url}/pr-999`, { method: "DELETE" }));
  expect(missing.status).toBe(404);

  const closed = await routes.handle(new Request(`${url}/pr-1`, { method: "DELETE" }));
  expect(closed.status).toBe(200);
  expect((await closed.json()).released).toEqual(["storage", "queues", "database"]);

  const listed = await routes.handle(new Request(url));
  expect((await listed.json()).previews).toEqual([]);
});

test("reclaims only timeout-due previews", async () => {
  const routes = app({
    ports: ports(),
    initial: [
      { preview: composePreviewEnvironment({ ...input, previewRef: "pr-1", lifecycle: { reclaimOn: "timeout", timeoutHours: 24 } }), created_at: "2026-09-20T00:00:00.000Z" },
      { preview: composePreviewEnvironment({ ...input, previewRef: "pr-2", lifecycle: { reclaimOn: "timeout", timeoutHours: 24 } }), created_at: "2026-09-30T00:00:00.000Z" },
    ],
  });
  const response = await routes.handle(new Request(`${url}/reclaim`, { method: "POST" }));
  expect(response.status).toBe(200);
  const report = await response.json();
  expect(report).toMatchObject({ checked: 2, reclaimed: 1 });
  expect(report.failed).toEqual([]);
});