import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applicationPreviewBranchRef, applicationReleaseId, parseApplicationPreviewReceipt,
  type ApplicationPreviewReceipt, type ApplicationReleaseRecord,
} from "@supacloud/delivery";
import { registerApplicationTools } from "./application-tools";
import { runAppTool } from "./app-tools";
import { HttpTransport } from "../transports/http";
import { executionMode } from "../execution-policy";
import type { ToolInvocation } from "../tool-server";

const previewId = "01234567-89ab-4def-8123-456789abcdef";
const configurationId = "11234567-89ab-4def-8123-456789abcdef";
const source: ApplicationReleaseRecord = {
  schema: "supacloud.application-release.v1", project_ref: "demo", application_id: "api",
  manifest_sha256: "a".repeat(64), release_id: applicationReleaseId("demo", "api", "a".repeat(64)),
  created_at: "2026-10-11T00:00:00.000Z",
  targets: [{ name: "api", kind: "http", object_id: "b".repeat(64), entrypoint: "bundle/index.js" }],
};
const scope = { ref: "demo", id: "api", environment_id: "test" };

function receipt(id = previewId): ApplicationPreviewReceipt {
  const branch = applicationPreviewBranchRef(id);
  const releaseId = applicationReleaseId(branch, "api", source.manifest_sha256);
  return {
    schema: "supacloud.application-preview.v1", preview_id: id,
    project_ref: "demo", application_id: "api", environment_id: "test", release_id: releaseId, status: "provisioning",
    expires_at: "2026-10-11T00:00:00.000Z",
    resources: {
      build_artifact: { status: "ready", release_id: releaseId },
      database_branch: { status: "pending", branch_ref: branch, data_mode: "schema_only" },
      queue_namespace: { status: "pending", namespace: "preview_fixture" },
      storage_namespace: { status: "pending", namespace: branch },
      test_secret: { status: "pending", name: "PREVIEW_FIXTURE_TOKEN", value_issued: false },
      configuration_revision: { status: "pending", configuration_id: null },
      application_activation: { status: "pending", activation_id: null },
      smoke_test: { status: "pending", checks: ["application_readiness"], passed: [], failed: [] },
    },
    cleanup: { required: true, completed: false, error: null },
  };
}
function handler(http: HttpTransport): ToolInvocation {
  let invoke: ToolInvocation | undefined;
  registerApplicationTools({ tool(_name, _description, _schema, callback) { invoke = callback; } }, http);
  if (!invoke) throw new Error("Missing application tool");
  return invoke;
}
function payload(result: Awaited<ReturnType<ToolInvocation>>): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text);
}

test("create sends a stable generated identity once and verifies the branch artifact", async () => {
  const requests: string[] = [];
  let createdId = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests.push(request.method);
    if (request.method === "GET") return Response.json({ project_ref: "demo", application_id: "api", release: source });
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || !("preview_id" in body) || typeof body.preview_id !== "string") {
      return new Response("Invalid", { status: 400 });
    }
    expect(body).toMatchObject({ release_id: source.release_id, data_mode: "schema_only" });
    createdId = body.preview_id;
    return Response.json(receipt(createdId), { status: 202 });
  } });
  try {
    const result = await handler(new HttpTransport({ baseUrl: `http://127.0.0.1:${server.port}`, token: "fixture" }))({
      ...scope, action: "create_preview", release_id: source.release_id,
    });
    expect(payload(result)).toMatchObject({ ok: true, preview_id: createdId, preview: receipt(createdId) });
    expect(createdId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(requests).toEqual(["GET", "POST"]);
  } finally { server.stop(true); }
});

test("preview-plan uses only one GET and preserves its identity", async () => {
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.pathname}`);
    expect(url.searchParams.get("preview_id")).toBe(previewId);
    expect(url.searchParams.get("branch_ref")).toBe(applicationPreviewBranchRef(previewId));
    const preview = receipt();
    preview.status = "planned";
    preview.expires_at = null;
    const candidate = applicationReleaseId(applicationPreviewBranchRef(previewId), "api", source.manifest_sha256);
    preview.release_id = candidate;
    preview.resources.build_artifact.release_id = candidate;
    return Response.json(preview);
  } });
  try {
    const invoke = handler(new HttpTransport({ baseUrl: `http://127.0.0.1:${server.port}`, token: "fixture" }));
    const result = await runAppTool({ ...scope, action: "preview-plan", release_id: source.release_id, preview_id: previewId }, {
      getApplications: () => invoke,
    });
    expect(result.content[0]!.text).toContain("demo/api/test: planned");
    expect(requests).toEqual(["GET /v1/projects/demo/applications/api/environments/test/preview-plan"]);
  } finally { server.stop(true); }
});

test.each([408, 503])("uncertain creation HTTP %s preserves preview ID without retry", async status => {
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push(request.method);
    return request.method === "GET"
      ? Response.json({ project_ref: "demo", application_id: "api", release: source })
      : Response.json({ private: "credential-marker" }, { status });
  } });
  try {
    const result = await handler(new HttpTransport({ baseUrl: `http://127.0.0.1:${server.port}`, token: "fixture" }))({
      ...scope, action: "create_preview", release_id: source.release_id, preview_id: previewId,
    });
    expect(payload(result)).toMatchObject({ ok: false, preview_id: previewId, error: { code: "OUTCOME_UNKNOWN" } });
    expect(result.content[0]!.text).not.toContain("credential-marker");
    expect(requests).toEqual(["GET", "POST"]);
  } finally { server.stop(true); }
});

test.each(["scope", "id", "private", "ready", "secret"] as const)("rejects %s preview receipts without leaking payload", async fault => {
  const preview = receipt();
  const invalid = fault === "scope" ? { ...preview, environment_id: "production" }
    : fault === "id" ? { ...preview, preview_id: configurationId }
    : fault === "private" ? { ...preview, private: "credential-marker" }
    : fault === "ready" ? { ...preview, status: "ready" }
    : { ...preview, resources: { ...preview.resources, test_secret: { ...preview.resources.test_secret, value: "credential-marker" } } };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(invalid) });
  try {
    const result = await handler(new HttpTransport({ baseUrl: `http://127.0.0.1:${server.port}`, token: "fixture" }))({
      ...scope, action: "get_preview", preview_id: previewId,
    });
    expect(payload(result)).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
    expect(result.content[0]!.text).not.toContain("credential-marker");
  } finally { server.stop(true); }
});

test("reads, recovery and cleanup use separate verbs and concise defaults", async () => {
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    if (path.endsWith("/previews")) return Response.json({
      project_ref: "demo", application_id: "api", environment_id: "test", previews: [receipt()],
    });
    return Response.json(receipt());
  } });
  try {
    const invoke = handler(new HttpTransport({ baseUrl: `http://127.0.0.1:${server.port}`, token: "fixture" }));
    const options = { getApplications: () => invoke };
    expect((await runAppTool({ ...scope, action: "preview-list" }, options)).content[0]!.text).toContain(previewId);
    const status = await runAppTool({ ...scope, action: "preview-status", preview_id: previewId }, options);
    expect(status.content[0]!.text).toContain("demo/api/test: provisioning");
    const json = await runAppTool({ ...scope, action: "preview-status", preview_id: previewId, json: true }, options);
    expect(payload(json)).toMatchObject({ ok: true, preview: receipt() });
    const reconcile = await invoke({ ...scope, action: "reconcile_preview", preview_id: previewId });
    expect(payload(reconcile)).toMatchObject({ ok: true });
    const cleanup = await invoke({ ...scope, action: "cleanup_preview", preview_id: previewId });
    expect(payload(cleanup)).toMatchObject({ ok: false, error: { code: "MUTATION_NOT_SUCCEEDED" } });
    expect(requests.map(request => request.split(" ")[0])).toEqual(["GET", "GET", "GET", "POST", "DELETE"]);
  } finally { server.stop(true); }
});

test("DELETE responses are bounded and an oversized response is an unknown write", async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    requests++;
    return new Response(" ".repeat(262_145), { headers: { "content-length": "262145", "content-type": "application/json" } });
  } });
  try {
    const result = await handler(new HttpTransport({ baseUrl: `http://127.0.0.1:${server.port}`, token: "fixture" }))({
      ...scope, action: "cleanup_preview", preview_id: previewId,
    });
    expect(payload(result)).toMatchObject({ preview_id: previewId, error: { code: "OUTCOME_UNKNOWN" } });
    expect(requests).toBe(1);
  } finally { server.stop(true); }
});

test("input validation precedes HTTP and preview writes are separately classified", async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { requests++; return Response.json(receipt()); } });
  try {
    const invoke = handler(new HttpTransport({ baseUrl: `http://127.0.0.1:${server.port}`, token: "fixture" }));
    await expect(invoke({ ...scope, action: "get_preview" })).rejects.toThrow("preview_id");
    await expect(invoke({ ...scope, action: "create_preview", release_id: source.release_id, data_mode: "unsafe" })).rejects.toThrow();
    expect(requests).toBe(0);
    expect(executionMode("app", "preview-status", {})).toBe("read");
    expect(executionMode("app", "preview-plan", {})).toBe("read");
    expect(executionMode("app", "preview", {})).toBe("write");
    expect(executionMode("applications", "reconcile_preview", {})).toBe("write");
    expect(executionMode("applications", "cleanup_preview", {})).toBe("write");
    expect(() => parseApplicationPreviewReceipt({ ...receipt(), status: "cleaned" })).toThrow();
  } finally { server.stop(true); }
});

test("real CLI permits read-only production status but refuses creation before HTTP", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-cli-"));
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push(request.method);
    return Response.json(receipt());
  } });
  const env = Object.fromEntries(Object.entries(process.env).filter(
    ([key, value]) => value !== undefined && !/^(SUPACLOUD_|SUPABASE_|X_PROJECT_REF$|MANAGEMENT_API_URL$)/.test(key),
  ));
  const run = async (action: string) => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../../index.ts", import.meta.url)),
      "--env", "prod", "app", action, "--id", "api", "--environment_id", "test",
      "--preview_id", previewId, ...(action === "preview" ? ["--release_id", source.release_id] : [])], {
      cwd: root, env, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  try {
    await Bun.write(join(root, ".env.supacloud.prod"), [
      "SUPACLOUD_ENV=production", "SUPACLOUD_PROJECT_REF=demo",
      `SUPACLOUD_API_URL=http://127.0.0.1:${server.port}`,
      "SUPACLOUD_API_TOKEN=fixture", "SUPACLOUD_READ_ONLY=true",
    ].join("\n"));
    const status = await run("preview-status");
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout).toContain("demo/api/test: provisioning");
    const create = await run("preview");
    expect(create.code).toBe(1);
    expect(create.stderr).toContain("read-only");
    expect(requests).toEqual(["GET"]);
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
}, 30_000);
