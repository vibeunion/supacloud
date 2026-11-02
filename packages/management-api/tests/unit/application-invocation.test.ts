import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ApplicationActiveRecord } from "../../src/services/application-activation";
import {
  developerInvocationPolicy,
  invokeApplicationRoute,
  type DeveloperInvocationPolicy,
} from "../../src/services/application-invocation";

let server: ReturnType<typeof Bun.serve>;
let port: number;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return Response.json({ ok: true, authorization: request.headers.get("authorization") });
      }
      if (url.pathname === "/echo") {
        return request.text().then((body) => Response.json({
          body,
          content_type: request.headers.get("content-type"),
        }));
      }
      if (url.pathname === "/redirect") return Response.redirect("/health", 302);
      if (url.pathname === "/large") {
        return new Response("x".repeat(300 * 1024), { headers: { "content-type": "text/plain" } });
      }
      if (url.pathname === "/cookie") {
        return Response.json({ ok: true }, { headers: { "set-cookie": "secret=1" } });
      }
      return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
    },
  });
  port = server.port;
});

afterAll(() => server.stop(true));

function activeRecord(): ApplicationActiveRecord {
  return {
    schema: "supacloud.application-active.v1",
    configurationDigest: "a".repeat(64),
    runtime: {
      release: {
        project_ref: "demo",
        application_id: "app",
        release_id: "b".repeat(64),
        targets: [{ name: "api", kind: "http" }],
      },
      activationId: "00000000-0000-4000-8000-000000000001",
      environmentId: "test",
      ports: { api: port },
    },
  } as unknown as ApplicationActiveRecord;
}

const policy: DeveloperInvocationPolicy = {
  enabled: true,
  environments: ["test"],
  methods: ["GET", "POST"],
};

function invoke(overrides: Record<string, unknown> = {}) {
  return invokeApplicationRoute({
    projectRef: "demo",
    applicationId: "app",
    environmentId: "test",
    target: "api",
    method: "GET",
    path: "/health",
    ...overrides,
  } as Parameters<typeof invokeApplicationRoute>[0], policy, {
    readActive: async () => activeRecord(),
  });
}

test("policy is disabled until an operator names test environments", () => {
  expect(developerInvocationPolicy({})).toEqual({ enabled: false, environments: [], methods: ["GET", "HEAD"] });
  expect(developerInvocationPolicy({
    SUPACLOUD_DEVELOPER_MCP_INVOKE_ENVIRONMENTS: "test, staging,test",
    SUPACLOUD_DEVELOPER_MCP_INVOKE_METHODS: "get,POST",
  })).toEqual({ enabled: true, environments: ["test", "staging"], methods: ["GET", "POST"] });
});

test("invokes an active loopback target without forwarding caller credentials", async () => {
  const result = await invoke();
  expect(result).toMatchObject({
    schema: "supacloud.application-invocation.v1",
    mode: "allowlisted_test_invocation",
    project_ref: "demo",
    application_id: "app",
    environment_id: "test",
    target: "api",
    method: "GET",
    path: "/health",
    status: 200,
    credentials_forwarded: false,
    redirects_followed: false,
  });
  expect(JSON.parse(String(result["body"]))).toEqual({ ok: true, authorization: null });
});

test("forwards a bounded body only to an allowlisted method", async () => {
  const result = await invoke({
    method: "POST",
    path: "/echo",
    body: JSON.stringify({ case_id: "c1" }),
    contentType: "application/json",
  });
  expect(result["status"]).toBe(200);
  expect(JSON.parse(String(result["body"]))).toEqual({
    body: JSON.stringify({ case_id: "c1" }),
    content_type: "application/json",
  });
  await expect(invoke({ method: "GET", body: "not allowed" })).rejects.toThrow("cannot include a body");
  await expect(invoke({ method: "POST", body: "x".repeat(64 * 1024 + 1) }))
    .rejects.toThrow("exceeds the Developer MCP invocation limit");
});

test("rejects environments, methods, targets and paths outside the allowlist", async () => {
  await expect(invoke({ environmentId: "production" })).rejects.toThrow("not allowlisted");
  await expect(invoke({ method: "DELETE" })).rejects.toThrow("not allowlisted");
  await expect(invoke({ target: "worker" })).rejects.toThrow("not an active HTTP target");
  await expect(invoke({ path: "//evil.example/health" })).rejects.toThrow("loopback origin");
  await expect(invoke({ path: "/health/../../secret" })).rejects.toThrow("request path");
  await expect(invoke({ path: "https://evil.example/health" })).rejects.toThrow("request path");
});

test("does not follow redirects or return response cookies", async () => {
  await expect(invoke({ path: "/redirect" })).rejects.toThrow();
  const cookie = await invoke({ path: "/cookie" });
  expect(JSON.stringify(cookie)).not.toContain("secret=1");
});

test("truncates oversized textual responses", async () => {
  const result = await invoke({ path: "/large" });
  expect(result["status"]).toBe(200);
  expect(result["body_truncated"]).toBe(true);
  expect(String(result["body"])).toHaveLength(256 * 1024);
});
