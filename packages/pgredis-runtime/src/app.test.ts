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
            },
            release() {},
          };
        },
        size() { return 0; },
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
      },
    });

    const response = await app.handle(request({ op: "get", key: "a" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "pgredis runtime tenant capacity is temporarily exhausted",
    });
  });
});
