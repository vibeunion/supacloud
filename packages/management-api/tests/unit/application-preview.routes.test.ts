import { expect, test } from "bun:test";
import { createApplicationRoutes } from "../../src/routes/applications";
import { buildApplicationPreviewReceipt, type StoredApplicationPreview } from "../../src/services/application-preview-contract";

const previewId = "21234567-89ab-4def-8123-456789abcdef";

function receipt(): StoredApplicationPreview {
  return {
    ...buildApplicationPreviewReceipt({
      previewId,
      projectRef: "demo",
      applicationId: "api",
      environmentId: "test",
      releaseId: "a".repeat(64),
      branchRef: "pv2123456789ab4def81",
      dataMode: "schema_only",
    }),
    status: "provisioning",
    branch_name: "api-preview",
    queue_name: "preview_2123456789ab4def8123",
    test_secret_name: "PREVIEW_TOKEN_2123456789AB4DEF8123",
    source_configuration_id: null,
    created_at: "2026-10-11T00:00:00.000Z",
    updated_at: "2026-10-11T00:00:00.000Z",
  };
}

function route(previews: {
  read: (projectRef: string, previewId: string) => Promise<StoredApplicationPreview | null>;
  get: (projectRef: string, previewId: string) => Promise<StoredApplicationPreview | null>;
  reconcile: (projectRef: string, previewId: string) => Promise<StoredApplicationPreview | null>;
}) {
  return createApplicationRoutes({
    authorize: async () => undefined,
    projectExists: async () => true,
    previews: previews as never,
  });
}

test("preview GET observes without reconciling and explicit POST reconcile resumes by ID", async () => {
  const calls: string[] = [];
  const current = receipt();
  const app = route({
    read: async () => { calls.push("read"); return current; },
    get: async () => { calls.push("get"); return current; },
    reconcile: async () => { calls.push("reconcile"); return { ...current, status: "ready" }; },
  });
  const base = "http://localhost/v1/projects/demo/applications/api/environments/test/previews";

  const observed = await app.handle(new Request(`${base}/${previewId}`));
  expect(observed.status).toBe(200);
  expect(await observed.json()).toMatchObject({ preview_id: previewId, status: "provisioning" });
  expect(calls).toEqual(["read", "get"]);

  const reconciled = await app.handle(new Request(`${base}/${previewId}/reconcile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }));
  expect(reconciled.status).toBe(200);
  expect(await reconciled.json()).toMatchObject({ preview_id: previewId, status: "ready" });
  expect(calls).toEqual(["read", "get", "read", "reconcile"]);
});
