import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { createPgredisRuntimeApp } from "./app";
import { TenantCapacityError, type TenantCache } from "./cache-registry";

const signingSecret = "internal-token-".padEnd(32, "x");

function capability(projectRef = "tenant-a"): string {
  const issuedAt = Date.now();
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    aud: "pgredis-runtime",
    scope: "cache",
    projectRef,
    sub: `${projectRef}_function`,
    iat: issuedAt,
    exp: issuedAt + 60_000,
  })).toString("base64url");
  return `${payload}.${createHmac("sha256", signingSecret).update(payload).digest("base64url")}`;
}

function request(body: unknown, authorization = `Bearer ${capability()}`) {
  return new Request("http://localhost/internal/v1/cache", {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function adminRequest(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-supacloud-internal-auth", signingSecret);
  if (init.body) headers.set("content-type", "application/json");
  return new Request(`http://localhost${path}`, { ...init, headers });
}

describe("pgredis-runtime internal API", () => {
  test("derives the tenant from a scoped capability and releases its lease", async () => {
    const calls: unknown[] = [];
    let releases = 0;
    const cache: TenantCache = {
      async get<T>(key: string) { calls.push(["get", key]); return { key } as T; },
      async set(key, value, options) { calls.push(["set", key, value, options]); return true; },
      async delete(key) { calls.push(["delete", key]); return true; },
      async ttl(key) { calls.push(["ttl", key]); return 500; },
      async getset<T>(key: string, value: T) { calls.push(["getset", key, value]); return "old" as T; },
      async getdel<T>(key: string) { calls.push(["getdel", key]); return "deleted" as T; },
      async flush() { calls.push(["flush"]); return 2; },
    };
    const app = createPgredisRuntimeApp({
      signingSecret,
      capabilityMaxTtlMs: 600_000,
      maxValueBytes: 1_024,
      maxTtlMs: 10_000,
      registry: {
        async acquire(ref) {
          expect(ref).toBe("tenant-a");
          return { cache, release() { releases++; } };
        },
        size() { return 1; },
        snapshot() {
          return {
            activeTenants: 1,
            maxTenants: 2,
            connectionsPerTenant: 1,
            l1: { enabled: true as const, maxEntries: 100, ttlMs: 1_000 },
            tenants: [],
          };
        },
        async projectStatus(ref) {
          return {
            projectRef: ref,
            configured: true,
            active: true,
            configurationCurrent: true,
            leases: 0,
            lastUsedAt: null,
          };
        },
      },
    });

    expect(await (await app.handle(request({ op: "get", key: "a" }))).json()).toEqual({ value: { key: "a" } });
    expect(await (await app.handle(request({ op: "set", key: "a", value: { n: 1 }, ttlMs: 500 }))).json()).toEqual({ written: true });
    expect(await (await app.handle(request({ op: "delete", key: "a" }))).json()).toEqual({ deleted: true });
    expect(await (await app.handle(request({ op: "ttl", key: "a" }))).json()).toEqual({ ttlMs: 500 });
    expect(await (await app.handle(request({ op: "getset", key: "a", value: "new" }))).json()).toEqual({ value: "old" });
    expect(await (await app.handle(request({ op: "getdel", key: "a" }))).json()).toEqual({ value: "deleted" });
    expect(releases).toBe(6);
    expect(calls.map((entry) => (entry as unknown[])[0])).toEqual([
      "get",
      "set",
      "delete",
      "ttl",
      "getset",
      "getdel",
    ]);

    expect((await app.handle(request({ op: "queue", key: "a" }))).status).toBe(400);
    expect((await app.handle(request({ op: "get", key: "a", projectRef: "tenant-b" }))).status).toBe(400);
    expect((await app.handle(new Request("http://localhost/internal/v1/rate-limit"))).status).toBe(404);
  });

  test("protects admin status and project-scoped cache operations with the internal token", async () => {
    const acquiredRefs: string[] = [];
    let releases = 0;
    const cache: TenantCache = {
      async get<T = unknown>(key: string): Promise<T | null> { return `value:${key}` as T; },
      async set() { return true; },
      async delete() { return true; },
      async ttl() { return 250; },
      async getset() { return null; },
      async getdel() { return null; },
      async flush() { return 3; },
    };
    const app = createPgredisRuntimeApp({
      signingSecret,
      capabilityMaxTtlMs: 600_000,
      maxValueBytes: 1_024,
      maxTtlMs: 10_000,
      registry: {
        async acquire(ref) {
          acquiredRefs.push(ref);
          return { cache, release() { releases++; } };
        },
        size() { return 1; },
        snapshot() {
          return {
            activeTenants: 1,
            maxTenants: 8,
            connectionsPerTenant: 2,
            l1: { enabled: true as const, maxEntries: 100, ttlMs: 1_000 },
            tenants: [{ projectRef: "tenant-a", leases: 0, lastUsedAt: "2026-07-27T00:00:00.000Z" }],
          };
        },
        async projectStatus(ref) {
          return {
            projectRef: ref,
            configured: true,
            active: true,
            configurationCurrent: true,
            leases: 0,
            lastUsedAt: "2026-07-27T00:00:00.000Z",
          };
        },
      },
    });

    expect((await app.handle(new Request("http://localhost/internal/v1/admin/status"))).status).toBe(401);
    const statusResponse = await app.handle(adminRequest("/internal/v1/admin/status"));
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      service: "pgredis-runtime",
      activeTenants: 1,
      queue: false,
      rateLimit: false,
    });
    const projectResponse = await app.handle(adminRequest("/internal/v1/admin/projects/tenant-a/status"));
    expect(await projectResponse.json()).toMatchObject({ projectRef: "tenant-a", configured: true });
    const refreshResponse = await app.handle(adminRequest("/internal/v1/admin/projects/tenant-a/refresh", {
      method: "POST",
    }));
    expect(await refreshResponse.json()).toMatchObject({ projectRef: "tenant-a", configurationCurrent: true });

    const invalidGetResponse = await app.handle(adminRequest("/internal/v1/admin/cache", {
      method: "POST",
      body: JSON.stringify({ projectRef: "tenant-a", op: "get" }),
    }));
    expect(invalidGetResponse.status).toBe(400);
    const getResponse = await app.handle(adminRequest("/internal/v1/admin/cache", {
      method: "POST",
      body: JSON.stringify({ projectRef: "tenant-a", op: "get", key: "one" }),
    }));
    expect(await getResponse.json()).toEqual({ value: "value:one" });
    const rejectedFlush = await app.handle(adminRequest("/internal/v1/admin/cache", {
      method: "POST",
      body: JSON.stringify({ projectRef: "tenant-a", op: "flush", confirmProjectRef: "tenant-b" }),
    }));
    expect(rejectedFlush.status).toBe(400);
    const flushResponse = await app.handle(adminRequest("/internal/v1/admin/cache", {
      method: "POST",
      body: JSON.stringify({ projectRef: "tenant-a", op: "flush", confirmProjectRef: "tenant-a" }),
    }));
    expect(await flushResponse.json()).toEqual({ deleted: 3 });
    expect(acquiredRefs).toEqual(["tenant-a", "tenant-a", "tenant-a"]);
    expect(releases).toBe(3);
  });

  test("fails closed for invalid capabilities and oversized values", async () => {
    const app = createPgredisRuntimeApp({
      signingSecret,
      capabilityMaxTtlMs: 600_000,
      maxValueBytes: 8,
      maxTtlMs: 10_000,
      registry: {
        async acquire() {
          return {
            cache: {
              async get() { return null; },
              async set() { return true; },
              async delete() { return false; },
              async ttl() { return null; },
              async getset() { return null; },
              async getdel() { return null; },
              async flush() { return 0; },
            },
            release() {},
          };
        },
        size() { return 0; },
        snapshot() {
          return {
            activeTenants: 0,
            maxTenants: 1,
            connectionsPerTenant: 1,
            l1: { enabled: true as const, maxEntries: 1, ttlMs: 1 },
            tenants: [],
          };
        },
        async projectStatus(ref) {
          return {
            projectRef: ref,
            configured: false,
            active: false,
            configurationCurrent: false,
            leases: 0,
            lastUsedAt: null,
          };
        },
      },
    });

    expect((await app.handle(request({ op: "get", key: "a" }, "Bearer wrong"))).status).toBe(401);
    expect((await app.handle(request({ op: "set", key: "a", value: "too-large" }))).status).toBe(400);
    const health = await (await app.handle(new Request("http://localhost/health"))).json();
    expect(health).toMatchObject({ l1: true, queue: false, rateLimit: false });
  });

  test("returns 503 when tenant capacity is exhausted", async () => {
    const app = createPgredisRuntimeApp({
      signingSecret,
      capabilityMaxTtlMs: 600_000,
      maxValueBytes: 1_024,
      maxTtlMs: 10_000,
      registry: {
        async acquire() {
          throw new TenantCapacityError();
        },
        size() { return 1; },
        snapshot() {
          return {
            activeTenants: 1,
            maxTenants: 1,
            connectionsPerTenant: 1,
            l1: { enabled: true as const, maxEntries: 1, ttlMs: 1 },
            tenants: [],
          };
        },
        async projectStatus(ref) {
          return {
            projectRef: ref,
            configured: true,
            active: false,
            configurationCurrent: true,
            leases: 0,
            lastUsedAt: null,
          };
        },
      },
    });

    const response = await app.handle(request({ op: "get", key: "a" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "pgredis runtime tenant capacity is temporarily exhausted",
    });
  });
});
