import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { applicationReleaseId, type ApplicationReleaseRecord } from "@supacloud/delivery";
import { HttpTransport } from "../transports/http";
import { executionMode, validateExecutionPolicyCoverage } from "../execution-policy";
import { parseToolArguments, type ToolSchema } from "../schema";
import { registerApplicationTools, APPLICATION_TOOL_SCHEMA } from "./application-tools";
import { runAppTool, registerAppTools, type ToolResult } from "./app-tools";
import { type ApplicationPreviewReceipt } from "./application-preview-tools";

const ref = "project", id = "orders", environment = "test";
const manifest = "a".repeat(64);
const configurationId = "11234567-89ab-4def-8123-456789abcdef";
const previewId = "21234567-89ab-4def-8123-456789abcdef";
const activationId = "31234567-89ab-4def-8123-456789abcdef";
const branchRef = `pv${previewId.replaceAll("-", "").slice(0, 18)}`;
const path = `/v1/projects/${ref}/applications/${id}/environments/${environment}`;
const sourceRelease: ApplicationReleaseRecord = {
  schema: "supacloud.application-release.v1", project_ref: ref, application_id: id,
  release_id: applicationReleaseId(ref, id, manifest), manifest_sha256: manifest,
  created_at: "2026-10-10T00:00:00.000Z",
  targets: [{ name: "api", kind: "http", object_id: "b".repeat(64), entrypoint: "bundle/index.js" }],
};
const args = { ref, id, environment_id: environment };

function preview(status: ApplicationPreviewReceipt["status"] = "provisioning"): ApplicationPreviewReceipt {
  const releaseId = applicationReleaseId(branchRef, id, manifest);
  const ready = status === "ready";
  const phase = status === "cleaned" ? "cleaned" as const : ready ? "ready" as const : "pending" as const;
  const checks = [
    "release_artifact", "database_branch", "queue_namespace", "storage_namespace", "test_secret",
    "configuration_revision", "application_activation", "application_readiness", "tenant_runtime",
  ];
  return {
    schema: "supacloud.application-preview.v1", preview_id: previewId, project_ref: ref,
    application_id: id, environment_id: environment, release_id: releaseId, status,
    resources: {
      build_artifact: { status: "ready", release_id: releaseId },
      database_branch: { status: phase, branch_ref: branchRef, data_mode: "schema_only" },
      queue_namespace: { status: phase, namespace: `preview_${previewId}` },
      storage_namespace: { status: phase, namespace: branchRef },
      test_secret: { status: phase, name: "PREVIEW_TOKEN_TEST", value_issued: false },
      configuration_revision: { status: phase, configuration_id: ready ? configurationId : null },
      application_activation: { status: phase, activation_id: ready ? activationId : null },
      smoke_test: {
        status: status === "failed" ? "failed" : phase,
        checks, passed: ready ? checks : [], failed: status === "failed" ? ["application_readiness"] : [],
      },
    },
    cleanup: { required: status !== "cleaned", completed: status === "cleaned", error: null },
    source_configuration_id: configurationId, branch_name: "orders-preview", queue_name: "preview_test",
    test_secret_name: "PREVIEW_TOKEN_TEST",
    created_at: "2026-10-10T00:00:00.000Z", updated_at: "2026-10-10T00:00:00.000Z",
  };
}

function plan() {
  const value = preview("planned");
  value.release_id = sourceRelease.release_id;
  value.resources.build_artifact.release_id = sourceRelease.release_id;
  value.resources.database_branch.branch_ref = "preview-orders";
  value.resources.storage_namespace.namespace = "preview-orders";
  return value;
}

function output(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text);
}

function register(http: HttpTransport) {
  let callback: ((args: Record<string, unknown>) => Promise<ToolResult>) | undefined;
  registerApplicationTools({
    tool(name, _description, schema, handler) {
      validateExecutionPolicyCoverage({ [name]: { schema } });
      callback = handler;
    },
  }, http);
  if (!callback) throw new Error("Applications tool missing");
  return callback;
}

async function withServer(
  fetch: (request: Request) => Response | Promise<Response>,
  run: (http: HttpTransport, origin: string) => Promise<void>,
) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch });
  const origin = `http://127.0.0.1:${server.port}`;
  try { await run(new HttpTransport({ baseUrl: origin, token: "fixture-management-token" }), origin); }
  finally { server.stop(true); }
}

test("preview aliases preserve receipts and classify status recovery as a write", async () => {
  let schema: ToolSchema = {};
  registerAppTools({ tool(_name, _description, value) { schema = value; } });
  validateExecutionPolicyCoverage({ app: { schema }, applications: { schema: APPLICATION_TOOL_SCHEMA } });
  const aliases = {
    "preview-plan": "get_preview_plan", preview: "create_preview", previews: "list_previews",
    "preview-status": "get_preview", "preview-cleanup": "cleanup_preview",
  } as const;
  for (const [alias, action] of Object.entries(aliases)) {
    expect(executionMode("app", alias, {})).toBe(alias === "preview-plan" ? "read" : "write");
    expect(executionMode("applications", action, {})).toBe(alias === "preview-plan" ? "read" : "write");
    const receipt = { content: [{ type: "text" as const, text: '{"fixture":true}' }] };
    const result = await runAppTool({ action: alias as keyof typeof aliases, ...args }, {
      getApplications: () => async request => {
        expect(request).toEqual({ ...args, action });
        return receipt;
      },
    });
    expect(result).toBe(receipt);
  }
  for (const change of [{ preview_id: "../foreign" }, { release_id: "latest" }, { data_mode: "guess" }]) {
    expect(() => parseToolArguments(schema, { action: "preview", ...args, ...change })).toThrow();
  }
});

test("preview plan sends one GET and retains its planned status", async () => {
  const requests: string[] = [];
  await withServer(request => {
    requests.push(`${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`);
    return Response.json(plan());
  }, async http => {
    const result = await register(http)({
      action: "get_preview_plan", ...args, release_id: sourceRelease.release_id, branch_ref: "preview-orders",
    });
    expect(result.isError).not.toBe(true);
    expect(output(result)).toMatchObject({ ok: true, preview: { status: "planned" } });
  });
  expect(requests).toEqual([`GET ${path}/preview-plan?release_id=${sourceRelease.release_id}&branch_ref=preview-orders`]);
});

test("preview creation verifies the source then posts once without claiming readiness or leaking stored fields", async () => {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  await withServer(async request => {
    requests.push({ method: request.method, path: new URL(request.url).pathname,
      body: request.method === "POST" ? await request.json() : null });
    return Response.json(request.method === "GET"
      ? { project_ref: ref, application_id: id, release: sourceRelease }
      : preview(), { status: request.method === "GET" ? 200 : 202 });
  }, async http => {
    const result = await register(http)({
      action: "create_preview", ...args, release_id: sourceRelease.release_id, configuration_id: configurationId,
    });
    expect(output(result)).toMatchObject({ ok: true, preview: { status: "provisioning", preview_id: previewId } });
    expect(result.isError).not.toBe(true);
    expect(output(result).ready).toBeUndefined();
    for (const field of ["source_configuration_id", "queue_name", "test_secret_name", "created_at", "branch_name"]) {
      expect(result.content[0]!.text).not.toContain(`"${field}"`);
    }
  });
  expect(requests).toEqual([
    { method: "GET", path: `/v1/projects/${ref}/applications/${id}/releases/${sourceRelease.release_id}`, body: null },
    { method: "POST", path: `${path}/previews`, body: {
      release_id: sourceRelease.release_id, configuration_id: configurationId, data_mode: "schema_only",
    } },
  ]);
});

test("missing immutable configuration or foreign source release prevents create before mutation", async () => {
  let posts = 0, gets = 0;
  await withServer(request => {
    if (request.method === "POST") posts++;
    else gets++;
    return Response.json({ project_ref: ref, application_id: id, release: { ...sourceRelease, project_ref: "foreign" } });
  }, async http => {
    const tool = register(http);
    await expect(tool({ action: "create_preview", ...args, release_id: sourceRelease.release_id })).rejects.toThrow("configuration_id");
    expect(gets).toBe(0);
    const result = await tool({
      action: "create_preview", ...args, release_id: sourceRelease.release_id, configuration_id: configurationId,
    });
    expect(output(result)).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
  });
  expect(posts).toBe(0);
  expect(gets).toBe(1);
});

test("unknown, foreign, modified or secret-bearing create receipts never trigger a retry", async () => {
  const candidates: unknown[] = [
    {},
    { ...preview(), environment_id: "production" },
    { ...preview(), release_id: "f".repeat(64) },
    { ...preview(), source_configuration_id: "41234567-89ab-4def-8123-456789abcdef" },
    { ...preview(), resources: { ...preview().resources, test_secret: { ...preview().resources.test_secret, value: "private-secret" } } },
    { ...preview(), secret: "private-secret" },
  ];
  for (const candidate of candidates) {
    let posts = 0;
    await withServer(request => {
      if (request.method === "GET") return Response.json({ project_ref: ref, application_id: id, release: sourceRelease });
      posts++;
      return Response.json(candidate, { status: 202 });
    }, async http => {
      const result = await register(http)({
        action: "create_preview", ...args, release_id: sourceRelease.release_id, configuration_id: configurationId,
      });
      expect(result.isError).toBe(true);
      expect(output(result)).toMatchObject({
        error: { code: "OUTCOME_UNKNOWN" }, project_ref: ref,
        reconciliation: { action: "list_previews", ...args },
      });
      expect(result.content[0]!.text).not.toContain("private-secret");
    });
    expect(posts).toBe(1);
  }
});

test("transport-failed creation preserves the source scope without exposing provider exceptions", async () => {
  let posts = 0;
  await withServer(request => {
    if (request.method === "GET") return Response.json({ project_ref: ref, application_id: id, release: sourceRelease });
    posts++;
    return Response.json({ error: "private-provider-token" }, { status: 503 });
  }, async http => {
    const result = await register(http)({
      action: "create_preview", ...args, release_id: sourceRelease.release_id, configuration_id: configurationId,
    });
    expect(output(result)).toMatchObject({ error: { code: "OUTCOME_UNKNOWN" }, source_release_id: sourceRelease.release_id });
    expect(result.content[0]!.text).not.toContain("private-provider-token");
  });
  expect(posts).toBe(1);
});

test("status rejects incomplete readiness while preserving a failed preview for cleanup", async () => {
  for (const status of ["ready", "failed"] as const) {
    const value = preview(status);
    if (status === "ready") value.resources.application_activation.activation_id = null;
    await withServer(() => Response.json(value), async http => {
      const result = await register(http)({ action: "get_preview", ...args, preview_id: previewId });
      expect(result.isError).toBe(true);
      expect(output(result)).toMatchObject({
        error: { code: status === "ready" ? "INVALID_RESPONSE" : "MUTATION_NOT_SUCCEEDED" },
        ...(status === "failed" ? { preview: { status: "failed", cleanup: { required: true, completed: false } } } : {}),
      });
    });
  }
});

test("status accepts complete branch readiness and rejects a foreign receipt ID", async () => {
  for (const foreign of [false, true]) {
    const value = preview("ready");
    if (foreign) value.preview_id = "41234567-89ab-4def-8123-456789abcdef";
    await withServer(() => Response.json(value), async http => {
      const result = await register(http)({ action: "get_preview", ...args, preview_id: previewId });
      expect(output(result)).toMatchObject(foreign
        ? { ok: false, error: { code: "INVALID_RESPONSE" } }
        : { ok: true, preview: { status: "ready", release_id: value.release_id } });
    });
  }
});

test("preview inventories bind every receipt and reject duplicate IDs", async () => {
  for (const values of [[preview()], [preview(), preview()], [{ ...preview(), project_ref: "foreign" }]]) {
    await withServer(() => Response.json({
      project_ref: ref, application_id: id, environment_id: environment, previews: values,
    }), async http => {
      const result = await register(http)({ action: "list_previews", ...args });
      expect(output(result).ok).toBe(values.length === 1 && values[0]?.project_ref === ref);
    });
  }
});

test("cleanup sends one bounded DELETE and requires a completed cleanup receipt", async () => {
  for (const status of ["cleaned", "failed", "ready"] as const) {
    const requests: string[] = [];
    await withServer(request => {
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json(preview(status));
    }, async http => {
      const result = await register(http)({ action: "cleanup_preview", ...args, preview_id: previewId });
      expect(output(result).ok).toBe(status === "cleaned");
      if (status !== "cleaned") expect(output(result)).toMatchObject({ error: { code: "MUTATION_NOT_SUCCEEDED" } });
    });
    expect(requests).toEqual([`DELETE ${path}/previews/${previewId}`]);
  }
});

test("cleanup rejects a completed flag when isolated resources are not reported cleaned", async () => {
  const value = preview("cleaned");
  value.resources.database_branch.status = "ready";
  await withServer(() => Response.json(value), async http => {
    const result = await register(http)({ action: "cleanup_preview", ...args, preview_id: previewId });
    expect(output(result)).toMatchObject({ ok: false, error: { code: "OUTCOME_UNKNOWN" } });
  });
});

test("ignored creation-only options fail before status HTTP dispatch", async () => {
  let requests = 0;
  await withServer(() => { requests++; return Response.json(preview()); }, async http => {
    await expect(register(http)({
      action: "get_preview", ...args, preview_id: previewId, configuration_id: configurationId,
    })).rejects.toThrow("Invalid option");
  });
  expect(requests).toBe(0);
});

test("status recovery requests are not automatically retried after a server error", async () => {
  let requests = 0;
  await withServer(() => {
    requests++;
    return Response.json({ error: "retry-must-be-explicit" }, { status: 503 });
  }, async http => {
    const result = await register(http)({ action: "get_preview", ...args, preview_id: previewId });
    expect(result.isError).toBe(true);
  });
  expect(requests).toBe(1);
});

test("ordinary GETs retain retry behavior while preview requests can disable it", async () => {
  let requests = 0;
  await withServer(() => Response.json({}, { status: ++requests === 1 ? 503 : 200 }), async http => {
    expect((await http.get("/read-only")).ok).toBe(true);
    expect(requests).toBe(2);
    await expect(http.get("/invalid", { timeoutMs: 0 })).rejects.toThrow("timeout");
  });
});

const entry = fileURLToPath(new URL("../../index.ts", import.meta.url));
async function cli(flags: string[], variables: Record<string, string> = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(SUPACLOUD_|SUPABASE_|MANAGEMENT_API_|X_PROJECT_REF)/.test(key)));
  const child = Bun.spawn([process.execPath, entry, ...flags], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    env: { ...env, ...variables }, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, output: stdout + stderr };
}

test("preview action help works without credentials and includes scoped flags", async () => {
  for (const [action, fields] of [
    ["preview", ["environment_id", "release_id", "configuration_id", "data_mode"]],
    ["preview-plan", ["environment_id", "release_id", "branch_ref"]],
    ["preview-status", ["environment_id", "preview_id"]],
    ["preview-cleanup", ["environment_id", "preview_id"]],
  ] as const) {
    const result = await cli(["app", action, "--help"]);
    expect(result.code, result.output).toBe(0);
    for (const field of fields) expect(result.output).toContain(`--${field} `);
  }
}, 30_000);

test("CLI preview recovery respects read-only and production guards before HTTP", async () => {
  let requests = 0;
  await withServer(() => { requests++; return Response.json(preview()); }, async (_http, origin) => {
    const env = { SUPACLOUD_API_URL: origin, SUPACLOUD_API_TOKEN: "fixture-management-token", SUPACLOUD_PROJECT_REF: ref };
    for (const action of ["preview", "previews", "preview-status", "preview-cleanup"]) {
      const input = [
        "app", action, "--id", id, "--environment_id", environment,
        ...(action === "preview" ? ["--release_id", sourceRelease.release_id, "--configuration_id", configurationId] : []),
        ...(action === "preview-status" || action === "preview-cleanup" ? ["--preview_id", previewId] : []),
      ];
      const readOnly = await cli(input, { ...env, SUPACLOUD_READ_ONLY: "true" });
      expect(readOnly.code, readOnly.output).toBe(1);
      expect(readOnly.output).toContain("read-only");
      const production = await cli(input, { ...env, SUPACLOUD_ENV: "production" });
      expect(production.code, production.output).toBe(1);
      expect(production.output).toContain(`--confirm-production ${ref}`);
    }
  });
  expect(requests).toBe(0);
}, 30_000);

test("CLI read-only preview plan uses the context ref and sends no resource mutation", async () => {
  const requests: string[] = [];
  await withServer(request => {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return Response.json(plan());
  }, async (_http, origin) => {
    const result = await cli([
      "app", "preview-plan", "--id", id, "--environment_id", environment,
      "--release_id", sourceRelease.release_id, "--branch_ref", "preview-orders",
    ], {
      SUPACLOUD_API_URL: origin, SUPACLOUD_API_TOKEN: "fixture-management-token",
      SUPACLOUD_PROJECT_REF: ref, SUPACLOUD_READ_ONLY: "true",
    });
    expect(result.code, result.output).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({ project_ref: ref, preview: { status: "planned" } });
  });
  expect(requests).toEqual([`GET ${path}/preview-plan`]);
}, 30_000);
