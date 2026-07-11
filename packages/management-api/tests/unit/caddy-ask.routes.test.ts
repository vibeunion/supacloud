import { describe, expect, test } from "bun:test";
import { createCaddyAskRoutes } from "../../src/routes/caddy-ask";

describe("Caddy ask route", () => {
  test("audits rejected unknown domains without exposing a broad base-domain allow", async () => {
    const audits: Array<Record<string, unknown>> = [];
    const app = createCaddyAskRoutes({
      resolvePeerAddress: () => "127.0.0.1",
      allowlist: {
        authorize: async (domain: string) => ({
          allowed: false as const,
          status: 403 as const,
          domain,
          reason: "not_registered" as const,
        }),
      },
      audit: async (input) => {
        audits.push(input as unknown as Record<string, unknown>);
      },
    });

    const response = await app.handle(new Request(
      "http://127.0.0.1/v1/gateway/caddy/ask?domain=unregistered.example.com",
    ));

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("domain not allowed");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      status: 403,
      action: "caddy_tls_ask_denied",
      metadata: { domain: "unregistered.example.com", reason: "not_registered" },
    });
  });

  test("rejects direct external callers before querying the domain allowlist", async () => {
    let authorizationCalls = 0;
    const app = createCaddyAskRoutes({
      resolvePeerAddress: () => "203.0.113.10",
      allowlist: {
        authorize: async (domain: string) => {
          authorizationCalls += 1;
          return {
            allowed: true as const,
            status: 200 as const,
            domain,
            reason: "project" as const,
          };
        },
      },
      audit: async () => {},
    });

    const response = await app.handle(new Request(
      "http://127.0.0.1/v1/gateway/caddy/ask?domain=project.example.com",
    ));

    expect(response.status).toBe(403);
    expect(authorizationCalls).toBe(0);
  });

  test("rejects public requests forwarded through local Caddy", async () => {
    let authorizationCalls = 0;
    const app = createCaddyAskRoutes({
      resolvePeerAddress: () => "127.0.0.1",
      allowlist: {
        authorize: async (domain: string) => {
          authorizationCalls += 1;
          return {
            allowed: true as const,
            status: 200 as const,
            domain,
            reason: "project" as const,
          };
        },
      },
      audit: async () => {},
    });

    const response = await app.handle(new Request(
      "http://127.0.0.1/v1/gateway/caddy/ask?domain=project.example.com",
      { headers: { "x-forwarded-for": "198.51.100.25" } },
    ));

    expect(response.status).toBe(403);
    expect(authorizationCalls).toBe(0);
  });

  test("applies a cheap endpoint quota before domain database lookups", async () => {
    let authorizationCalls = 0;
    const app = createCaddyAskRoutes({
      resolvePeerAddress: () => "::1",
      maxRequestsPerWindow: 1,
      now: () => 1_000,
      allowlist: {
        authorize: async (domain: string) => {
          authorizationCalls += 1;
          return {
            allowed: true as const,
            status: 200 as const,
            domain,
            reason: "project" as const,
          };
        },
      },
      audit: async () => {},
    });

    const first = await app.handle(new Request(
      "http://127.0.0.1/v1/gateway/caddy/ask?domain=project.example.com",
    ));
    const second = await app.handle(new Request(
      "http://127.0.0.1/v1/gateway/caddy/ask?domain=project.example.com",
    ));

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("60");
    expect(authorizationCalls).toBe(1);
  });
});
