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
    expires_at: "2026-10-11T00:00:00.000Z",
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
  value.expires_at = null;
  delete value.created_at;
  delete value.updated_at;
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

test("preview aliases preserve receipts and classify recovery as an explicit write", async () => {
  let schema: ToolSchema = {};
  registerAppTools({ tool(_name, _description, value) { schema = value; } });
  validateExecutionPolicyCoverage({ app: { schema }, applications: { schema: APPLICATION_TOOL_SCHEMA } });
  const aliases = {
    "preview-plan": "get_preview_plan", preview: "create_preview", previews: "list_previews",
    "preview-status": "get_preview", "preview-reconcile": "reconcile_preview", "preview-cleanup": "cleanup_preview",
  } as const;
  for (const [alias, action] of Object.entries(aliases)) {
    const readOnly = ["preview-plan", "previews", "preview-status"].includes(alias);
    expect(executionMode("app", alias, {})).toBe(readOnly ? "read" : "write");
    expect(executionMode("applications", action, {})).toBe(readOnly ? "read" : "write");
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
    expect(output(result)).toMatchObject({
      ok: true, preview: { status: "provisioning", preview_id: previewId, expires_at: preview().expires_at },
    });
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

test("preview reconciliation uses one explicit POST while status remains a read-only GET", async () => {
  const requests: string[] = [];
  await withServer(async request => {
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.pathname}`);
    if (url.pathname.includes("/reconcile")) return Response.json(preview("ready"));
    return Response.json(preview());
  }, async http => {
    const result = await register(http)({
      action: "reconcile_preview", ...args, preview_id: previewId,
    });
    expect(output(result)).toMatchObject({
      ok: true, operation: "applications.reconcile_preview",
      preview: { status: "ready", preview_id: previewId },
    });
  });
  expect(requests).toEqual([`POST ${path}/previews/${previewId}/reconcile`]);
});

test("TTL is forwarded to the platform as a plan query or one creation body", async () => {
  for (const ttlSeconds of [300, 3600, 604_800]) {
    for (const action of ["get_preview_plan", "create_preview"] as const) {
      let mutations = 0;
      const expiresAt = new Date(Date.parse(preview().created_at!) + ttlSeconds * 1000).toISOString();
      await withServer(async request => {
        const url = new URL(request.url);
        if (url.pathname.includes("/releases/")) {
          return Response.json({ project_ref: ref, application_id: id, release: sourceRelease });
        }
        if (action === "get_preview_plan") {
          expect(request.method).toBe("GET");
          expect(url.searchParams.get("ttl_seconds")).toBe(String(ttlSeconds));
          return Response.json({ ...plan(), expires_at: expiresAt });
        }
        mutations++;
        expect(await request.json()).toMatchObject({ ttl_seconds: ttlSeconds });
        return Response.json({ ...preview(), expires_at: expiresAt }, { status: 202 });
      }, async http => {
        const result = await register(http)({
          action, ...args, release_id: sourceRelease.release_id, ttl_seconds: ttlSeconds,
          ...(action === "get_preview_plan" ? { branch_ref: "preview-orders" } : { configuration_id: configurationId }),
        });
        expect(output(result)).toMatchObject({ ok: true, preview: { expires_at: expiresAt } });
      });
      expect(mutations).toBe(action === "create_preview" ? 1 : 0);
    }
  }
});

test("invalid TTL and wait options fail before any HTTP request", async () => {
  let requests = 0;
  await withServer(() => { requests++; return Response.json({}); }, async http => {
    const tool = register(http);
    for (const ttlSeconds of [0, 299, 604_801, 300.5, Number.NaN, Number.POSITIVE_INFINITY, "3600"]) {
      await expect(tool({
        action: "create_preview", ...args, release_id: sourceRelease.release_id,
        configuration_id: configurationId, ttl_seconds: ttlSeconds,
      })).rejects.toThrow("ttl_seconds");
    }
    for (const invalid of [
      { wait: "true" }, { timeout_seconds: 1 }, { wait: false, timeout_seconds: 1 },
      { wait: true, timeout_seconds: 0 }, { wait: true, timeout_seconds: 3601 },
      { wait: true, timeout_seconds: 1.5 }, { wait: true, timeout_seconds: Number.NaN },
    ]) {
      await expect(tool({ action: "get_preview", ...args, preview_id: previewId, ...invalid })).rejects.toThrow();
    }
    await expect(tool({ action: "get_preview", ...args, preview_id: previewId, ttl_seconds: 3600 })).rejects.toThrow("Invalid option");
    await expect(tool({ action: "cleanup_preview", ...args, preview_id: previewId, wait: true })).rejects.toThrow("Invalid option");
  });
  expect(requests).toBe(0);
});

test("creation rejects missing, malformed or mismatched expiry without recreating", async () => {
  for (const expiresAt of [
    undefined, null, "invalid", "2026-02-30T00:00:00.000Z",
    "2026-10-10T00:04:59.000Z", "2026-10-11T00:00:00.000Z",
  ]) {
    let mutations = 0;
    await withServer(request => {
      if (request.method === "GET") return Response.json({ project_ref: ref, application_id: id, release: sourceRelease });
      mutations++;
      return Response.json({ ...preview(), expires_at: expiresAt }, { status: 202 });
    }, async http => {
      const result = await register(http)({
        action: "create_preview", ...args, release_id: sourceRelease.release_id,
        configuration_id: configurationId, ttl_seconds: 300,
      });
      expect(output(result)).toMatchObject({ ok: false, error: { code: "OUTCOME_UNKNOWN" } });
    });
    expect(mutations).toBe(1);
  }
});

test("plan expiry is present only when a TTL was explicitly requested", async () => {
  for (const ttlSeconds of [undefined, 300]) {
    await withServer(() => Response.json({
      ...plan(), expires_at: ttlSeconds === undefined ? preview().expires_at : null,
    }), async http => {
      const result = await register(http)({
        action: "get_preview_plan", ...args, release_id: sourceRelease.release_id,
        branch_ref: "preview-orders", ...(ttlSeconds === undefined ? {} : { ttl_seconds: ttlSeconds }),
      });
      expect(output(result)).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
    });
  }
});

test("wait observes one accepted preview until complete readiness without another create request", async () => {
  const requests: string[] = [];
  let reads = 0;
  await withServer(request => {
    const pathname = new URL(request.url).pathname;
    requests.push(`${request.method} ${pathname}`);
    if (pathname.includes("/releases/")) return Response.json({ project_ref: ref, application_id: id, release: sourceRelease });
    if (request.method === "POST") return Response.json(preview(), { status: 202 });
    return Response.json(preview(++reads === 1 ? "provisioning" : "ready"));
  }, async http => {
    const result = await register(http)({
      action: "create_preview", ...args, release_id: sourceRelease.release_id,
      configuration_id: configurationId, wait: true, timeout_seconds: 5,
    });
    expect(output(result)).toMatchObject({
      ok: true, operation: "applications.create_preview",
      preview: { status: "ready", preview_id: previewId },
      waiting: { status: "ready", timeout_seconds: 5 },
    });
  });
  expect(requests).toEqual([
    `GET /v1/projects/${ref}/applications/${id}/releases/${sourceRelease.release_id}`,
    `POST ${path}/previews`, `GET ${path}/previews/${previewId}`, `GET ${path}/previews/${previewId}`,
  ]);
});

test("wait timeout preserves the accepted receipt and same-ID continuation without cleanup or recreation", async () => {
  const requests: string[] = [];
  await withServer(request => {
    const pathname = new URL(request.url).pathname;
    requests.push(`${request.method} ${pathname}`);
    return Response.json(pathname.includes("/releases/")
      ? { project_ref: ref, application_id: id, release: sourceRelease } : preview(),
    { status: request.method === "POST" ? 202 : 200 });
  }, async http => {
    const result = await register(http)({
      action: "create_preview", ...args, release_id: sourceRelease.release_id,
      configuration_id: configurationId, wait: true, timeout_seconds: 1,
    });
    expect(result.isError).toBe(true);
    expect(output(result)).toMatchObject({
      ok: false, preview_id: previewId, preview: { status: "provisioning" },
      waiting: { status: "timed_out", timeout_seconds: 1 },
      reconciliation: { action: "get_preview", ...args, preview_id: previewId, wait: true },
    });
  });
  expect(requests.filter(value => value.startsWith("POST"))).toEqual([`POST ${path}/previews`]);
  expect(requests.some(value => value.startsWith("DELETE"))).toBe(false);
});

test("wait stops on a provider error without retrying a lifecycle GET or losing the last accepted receipt", async () => {
  const requests: string[] = [];
  await withServer(request => {
    const pathname = new URL(request.url).pathname;
    requests.push(`${request.method} ${pathname}`);
    if (pathname.includes("/releases/")) return Response.json({ project_ref: ref, application_id: id, release: sourceRelease });
    if (request.method === "POST") return Response.json(preview(), { status: 202 });
    return Response.json({ error: "private-provider-secret" }, { status: 503 });
  }, async http => {
    const result = await register(http)({
      action: "create_preview", ...args, release_id: sourceRelease.release_id,
      configuration_id: configurationId, wait: true, timeout_seconds: 5,
    });
    expect(output(result)).toMatchObject({
      ok: false, error: { code: "HTTP_ERROR" }, preview: { status: "provisioning", preview_id: previewId },
      waiting: { status: "observation_failed" }, reconciliation: { action: "get_preview", preview_id: previewId },
    });
    expect(result.content[0]!.text).not.toContain("private-provider-secret");
  });
  expect(requests.filter(value => value === `GET ${path}/previews/${previewId}`)).toHaveLength(1);
  expect(requests.filter(value => value.startsWith("POST"))).toHaveLength(1);
});

test("wait rejects foreign readiness, digest drift and Secret-bearing receipts without reflecting them", async () => {
  const values = [
    { ...preview("ready"), environment_id: "production" },
    { ...preview("ready"), release_id: "e".repeat(64),
      resources: { ...preview("ready").resources, build_artifact: { status: "ready", release_id: "e".repeat(64) } } },
    { ...preview("ready"), expires_at: "2026-10-11T01:00:00.000Z" },
    { ...preview("ready"), private_secret: "private-provider-secret" },
  ];
  for (const value of values) {
    let observations = 0;
    await withServer(() => Response.json(++observations === 1 ? preview() : value), async http => {
      const result = await register(http)({
        action: "get_preview", ...args, preview_id: previewId, wait: true, timeout_seconds: 5,
      });
      expect(output(result)).toMatchObject({
        ok: false, error: { code: "INVALID_RESPONSE" }, preview: { status: "provisioning", preview_id: previewId },
      });
      expect(result.content[0]!.text).not.toContain("private-provider-secret");
    });
    expect(observations).toBe(2);
  }
});

test("wait cannot observe a different activation once the selected identity is known", async () => {
  const pending = preview();
  pending.resources.application_activation.activation_id = activationId;
  const changed = preview("ready");
  changed.resources.application_activation.activation_id = "41234567-89ab-4def-8123-456789abcdef";
  let observations = 0;
  await withServer(() => Response.json(++observations === 1 ? pending : changed), async http => {
    const result = await register(http)({
      action: "get_preview", ...args, preview_id: previewId, wait: true, timeout_seconds: 5,
    });
    expect(output(result)).toMatchObject({
      ok: false, error: { code: "INVALID_RESPONSE" }, preview: { status: "provisioning" },
    });
  });
  expect(observations).toBe(2);
});

test("a failed or cleaned preview ends waiting without a readiness claim", async () => {
  for (const status of ["failed", "cleaned"] as const) {
    let observations = 0;
    await withServer(() => Response.json(++observations === 1 ? preview() : preview(status)), async http => {
      const result = await register(http)({
        action: "get_preview", ...args, preview_id: previewId, wait: true, timeout_seconds: 5,
      });
      expect(output(result)).toMatchObject({
        ok: false, error: { code: "MUTATION_NOT_SUCCEEDED" }, preview: { status },
        waiting: { status: "stopped" },
      });
    });
    expect(observations).toBe(2);
  }
});

test("status wait allows slow headers within its full observation budget and does not poll an already ready preview", async () => {
  let observations = 0;
  await withServer(async () => {
    observations++;
    await Bun.sleep(650);
    return Response.json(preview("ready"));
  }, async http => {
    const result = await register(http)({
      action: "get_preview", ...args, preview_id: previewId, wait: true, timeout_seconds: 1,
    });
    expect(output(result)).toMatchObject({ ok: true, preview: { status: "ready" }, waiting: { status: "ready" } });
  });
  expect(observations).toBe(1);
});

test("slow headers and a stalled observation body share the deadline and preserve the accepted receipt", async () => {
  let observations = 0, mutations = 0;
  await withServer(async request => {
    const pathname = new URL(request.url).pathname;
    if (pathname.includes("/releases/")) return Response.json({ project_ref: ref, application_id: id, release: sourceRelease });
    if (request.method === "POST") { mutations++; return Response.json(preview(), { status: 202 }); }
    observations++;
    await Bun.sleep(650);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"private_secret":"do-not-echo"')); },
    }), { headers: { "content-type": "application/json" } });
  }, async http => {
    const started = performance.now();
    const result = await register(http)({
      action: "create_preview", ...args, release_id: sourceRelease.release_id,
      configuration_id: configurationId, wait: true, timeout_seconds: 1,
    });
    expect(performance.now() - started).toBeLessThan(1500);
    expect(output(result)).toMatchObject({
      ok: false, error: { code: "HTTP_ERROR" }, waiting: { status: "observation_failed" },
      preview: { status: "provisioning", preview_id: previewId },
      reconciliation: { action: "get_preview", preview_id: previewId },
    });
    expect(result.content[0]!.text).not.toContain("do-not-echo");
  });
  expect(observations).toBe(1);
  expect(mutations).toBe(1);
});

test("total HTTP deadline cannot enable retries, unbounded response reads or invalid timeouts", async () => {
  let requests = 0;
  await withServer(() => { requests++; return Response.json({}); }, async http => {
    for (const totalTimeoutMs of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(http.get("/invalid", {
        retry: false, maxJsonBytes: 1000, totalTimeoutMs,
      })).rejects.toThrow("timeout");
    }
    await expect(http.get("/invalid", { totalTimeoutMs: 1000, maxJsonBytes: 1000 })).rejects.toThrow("retry: false");
    await expect(http.get("/invalid", { totalTimeoutMs: 1000, retry: false })).rejects.toThrow("bounded JSON");
  });
  expect(requests).toBe(0);
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
    ["preview", ["environment_id", "release_id", "configuration_id", "data_mode", "ttl_seconds", "wait", "timeout_seconds"]],
    ["preview-plan", ["environment_id", "release_id", "branch_ref", "ttl_seconds"]],
    ["preview-status", ["environment_id", "preview_id", "wait", "timeout_seconds"]],
    ["preview-reconcile", ["environment_id", "preview_id"]],
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
    for (const action of ["preview", "preview-reconcile", "preview-cleanup"]) {
      const input = [
        "app", action, "--id", id, "--environment_id", environment,
        ...(action === "preview" ? ["--release_id", sourceRelease.release_id, "--configuration_id", configurationId] : []),
        ...(action === "preview-status" || action === "preview-reconcile" || action === "preview-cleanup"
          ? ["--preview_id", previewId] : []),
        ...(action === "preview" || action === "preview-status" ? ["--wait", "--timeout_seconds", "1"] : []),
        ...(action === "preview" ? ["--ttl_seconds", "300"] : []),
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

test("CLI creation wait forwards numeric TTL but keeps wait options local and emits one ready receipt", async () => {
  const requests: string[] = [];
  const expiresAt = "2026-10-10T00:05:00.000Z";
  await withServer(async request => {
    const pathname = new URL(request.url).pathname;
    requests.push(`${request.method} ${pathname}`);
    if (pathname.includes("/releases/")) return Response.json({ project_ref: ref, application_id: id, release: sourceRelease });
    if (request.method === "POST") {
      expect(await request.json()).toEqual({
        release_id: sourceRelease.release_id, configuration_id: configurationId,
        data_mode: "schema_only", ttl_seconds: 300,
      });
      return Response.json({ ...preview(), expires_at: expiresAt }, { status: 202 });
    }
    return Response.json({ ...preview("ready"), expires_at: expiresAt });
  }, async (_http, origin) => {
    const result = await cli([
      "app", "preview", "--id", id, "--environment_id", environment,
      "--release_id", sourceRelease.release_id, "--configuration_id", configurationId,
      "--ttl_seconds", "300", "--wait", "--timeout_seconds", "1",
    ], {
      SUPACLOUD_API_URL: origin, SUPACLOUD_API_TOKEN: "fixture-management-token", SUPACLOUD_PROJECT_REF: ref,
    });
    expect(result.code, result.output).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      ok: true, operation: "applications.create_preview",
      preview: { status: "ready", preview_id: previewId, expires_at: expiresAt },
      waiting: { status: "ready", timeout_seconds: 1 },
    });
    expect(result.output).not.toContain("fixture-management-token");
  });
  expect(requests).toEqual([
    `GET /v1/projects/${ref}/applications/${id}/releases/${sourceRelease.release_id}`,
    `POST ${path}/previews`, `GET ${path}/previews/${previewId}`,
  ]);
}, 30_000);

test("CLI status wait exits nonzero on timeout with the same Preview ID and no mutations", async () => {
  const requests: string[] = [];
  await withServer(request => {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return Response.json(preview());
  }, async (_http, origin) => {
    const result = await cli([
      "app", "preview-status", "--id", id, "--environment_id", environment,
      "--preview_id", previewId, "--wait", "--timeout_seconds", "1",
    ], {
      SUPACLOUD_API_URL: origin, SUPACLOUD_API_TOKEN: "fixture-management-token", SUPACLOUD_PROJECT_REF: ref,
    });
    expect(result.code, result.output).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      ok: false, preview: { status: "provisioning" }, waiting: { status: "timed_out" },
      reconciliation: { action: "get_preview", preview_id: previewId },
    });
  });
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(value => value === `GET ${path}/previews/${previewId}`)).toBe(true);
}, 30_000);
