import { afterEach, describe, expect, test } from "bun:test";
import { RealtimeService } from "../../src/services/realtime.service";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("RealtimeService tenant payloads", () => {
  test("registerTenant disables per-tenant postgres SSL for local service databases", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("{}", { status: 201 });
    }) as typeof fetch;

    const service = new RealtimeService();
    const ok = await service.registerTenant({
      projectRef: "testref",
      dbName: "postgres",
      dbPassword: "postgres",
      jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
    });

    expect(ok).toBe(true);
    const body = JSON.parse(String(calls[0]?.init?.body ?? "{}"));
    const settings = body.tenant.extensions[0].settings;
    expect(settings.ssl_enforced).toBe(false);
  });
});
