import { expect, spyOn, test } from "bun:test";
import { createApplicationRoutes } from "../../src/routes/applications";
import { buildApplicationPreviewReceipt, type StoredApplicationPreview } from "../../src/services/application-preview-contract";
import { applicationPreviewBranchRef, applicationReleaseId, parseApplicationPreviewReceipt } from "@supacloud/delivery";
import { ApplicationPreviewConflictError } from "../../src/repositories/project-config-writes";
import { ApplicationReleaseStorage } from "../../src/services/application-release-storage";
import { runtimeInput } from "../helpers/application-runtime";

const previewId = "01234567-89ab-4def-8123-456789abcdef";
const base = "http://localhost/v1/projects/demo/applications/api/environments/test/previews";
function stored(): StoredApplicationPreview {
  return {
    ...buildApplicationPreviewReceipt({
      previewId, projectRef: "demo", applicationId: "api", environmentId: "test",
      releaseId: "a".repeat(64), branchRef: "pv0123456789ab4def81", dataMode: "schema_only",
    }),
    status: "provisioning", branch_name: "internal-name", queue_name: "internal-queue",
    test_secret_name: "INTERNAL_TOKEN_NAME", source_configuration_id: null,
    created_at: "2026-10-11T00:00:00.000Z", updated_at: "2026-10-11T00:00:00.000Z",
  };
}
type Previews = NonNullable<Parameters<typeof createApplicationRoutes>[0]>["previews"];
function fixture() {
  const calls: string[] = [];
  let receipt = stored();
  const previews: NonNullable<Previews> = {
    list: async () => { calls.push("list"); return [receipt]; },
    get: async () => { calls.push("get"); return receipt; },
    create: async input => {
      calls.push("create");
      expect(input.previewId).toBe(previewId);
      return receipt;
    },
    reconcile: async () => { calls.push("reconcile"); return receipt; },
    cleanup: async () => { calls.push("cleanup"); return receipt; },
  };
  const api = createApplicationRoutes({ authorize: async () => undefined, projectExists: async () => true, previews });
  return { api, calls, previews, foreign: () => { receipt = { ...receipt, environment_id: "production" }; } };
}

test("preview GETs only read receipts and never expose internal storage metadata", async () => {
  const { api, calls } = fixture();
  const response = await api.handle(new Request(`${base}/${previewId}`));
  expect(response.status).toBe(200);
  const receipt = parseApplicationPreviewReceipt(await response.json());
  expect(receipt.status).toBe("provisioning");
  expect(receipt).not.toHaveProperty("source_configuration_id");
  expect(receipt).not.toHaveProperty("test_secret_name");
  const list = await api.handle(new Request(base));
  expect(list.status).toBe(200);
  expect(await list.json()).toMatchObject({ project_ref: "demo", previews: [receipt] });
  expect(calls).toEqual(["get", "list"]);
});

test("stable creation identity is forwarded and recovery requires an explicit POST", async () => {
  const { api, calls } = fixture();
  const response = await api.handle(new Request(base, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ release_id: "a".repeat(64), preview_id: previewId }),
  }));
  expect(response.status).toBe(202);
  expect(parseApplicationPreviewReceipt(await response.json()).preview_id).toBe(previewId);
  const resumed = await api.handle(new Request(`${base}/${previewId}/reconcile`, { method: "POST" }));
  expect(resumed.status).toBe(200);
  expect(calls).toEqual(["create", "get", "reconcile"]);
});

test("preview plan binds the source manifest to its candidate branch without creating resources", async () => {
  const { api, calls } = fixture();
  const release = {
    ...runtimeInput().release, project_ref: "demo", application_id: "api", release_id: "a".repeat(64),
  };
  const read = spyOn(ApplicationReleaseStorage.prototype, "readRelease").mockResolvedValue(release);
  const branchRef = applicationPreviewBranchRef(previewId);
  const query = new URLSearchParams({
    release_id: release.release_id, preview_id: previewId, branch_ref: branchRef,
  });
  const planUrl = base.replace(/\/previews$/, "/preview-plan");
  try {
    const response = await api.handle(new Request(`${planUrl}?${query}`));
    expect(response.status).toBe(200);
    expect(parseApplicationPreviewReceipt(await response.json())).toMatchObject({
      status: "planned", release_id: applicationReleaseId(branchRef, "api", release.manifest_sha256),
      resources: { database_branch: { branch_ref: branchRef } },
    });
    expect(read).toHaveBeenCalledWith("demo", "api", release.release_id);
    query.set("branch_ref", "foreign");
    const conflict = await api.handle(new Request(`${planUrl}?${query}`));
    expect(conflict.status).toBe(409);
    expect(calls).toEqual([]);
  } finally { read.mockRestore(); }
});

test("foreign receipts cannot authorize recovery or cleanup effects", async () => {
  const { api, calls, foreign } = fixture();
  foreign();
  for (const [method, url] of [
    ["GET", `${base}/${previewId}`],
    ["POST", `${base}/${previewId}/reconcile`],
    ["DELETE", `${base}/${previewId}`],
  ]) {
    const response = await api.handle(new Request(url, { method }));
    expect(response.status).toBe(404);
  }
  expect(calls).toEqual(["get", "get", "get"]);
});

test("authorization precedes preview reads and writes", async () => {
  const { calls, previews } = fixture();
  const api = createApplicationRoutes({
    authorize: async () => ({ status: 403, body: { error: "denied" } }),
    projectExists: async () => true, previews,
  });
  for (const [method, url] of [
    ["GET", base], ["GET", `${base}/${previewId}`],
    ["POST", `${base}/${previewId}/reconcile`], ["DELETE", `${base}/${previewId}`],
  ]) {
    const response = await api.handle(new Request(url, { method }));
    expect(response.status).toBe(403);
  }
  expect(calls).toEqual([]);
});

test("stable ID conflicts are explicit and provider failures are redacted", async () => {
  const { previews } = fixture();
  for (const [error, expected] of [
    [new ApplicationPreviewConflictError(), 409],
    [new Error("private-provider-credential"), 500],
  ] as const) {
    const api = createApplicationRoutes({
      authorize: async () => undefined, projectExists: async () => true,
      previews: { ...previews!, create: async () => { throw error; } },
    });
    const response = await api.handle(new Request(base, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ release_id: "a".repeat(64), preview_id: previewId }),
    }));
    expect(response.status).toBe(expected);
    expect(await response.text()).not.toContain("private-provider-credential");
  }
});
