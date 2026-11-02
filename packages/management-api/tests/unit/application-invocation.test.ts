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

const policy: DeveloperInvocationPolicy = { enabled: true, methods: ["GET", "HEAD"] };

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

test("policy follows the non-production convention without extra configuration", () => {
  expect(developerInvocationPolicy({})).toEqual({ enabled: false, methods: ["GET", "HEAD"] });
  expect(developerInvocationPolicy({ NODE_ENV: "production" })).toEqual({ enabled: false, methods: ["GET", "HEAD"] });
  expect(developerInvocationPolicy({ NODE_ENV: "test" })).toEqual({ enabled: true, methods: ["GET", "HEAD"] });
  expect(developerInvocationPolicy({ NODE_ENV: "development" })).toEqual({ enabled: true, methods: ["GET", "HEAD"] });
});

test("invokes an active loopback target without forwarding caller credentials", async () => {
  const result = await invoke();
  expect(result).toMatchObject({
    schema: "supacloud.application-invocation.v1",
    mode: "non_production_loopback",
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

test("write methods are rejected", async () => {
  await expect(invoke({ method: "POST", path: "/health" })).rejects.toThrow("method is not allowlisted");
});

test("rejects production environments, methods, targets and paths", async () => {
  await expect(invoke({ environmentId: "production" })).rejects.toThrow("not invocable");
  await expect(invoke({ environmentId: "prod" })).rejects.toThrow("not invocable");
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
