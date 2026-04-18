import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { sdkProxyRoutes } from "../../src/routes/sdk-proxy";
import * as dbModule from "../../src/db";

const app = new Elysia().use(sdkProxyRoutes);

type FetchCall = {
  url: string;
  init?: RequestInit & { duplex?: "half" };
};

function request(path: string, init?: RequestInit) {
  return app.handle(new Request(`http://localhost${path}`, init));
}

describe("sdkProxyRoutes functions proxy", () => {
  let originalFetch: typeof fetch;
  const calls: FetchCall[] = [];

  beforeEach(() => {
    calls.length = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit & { duplex?: "half" }) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      calls.push({ url, init });
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      }));
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("POST /functions/v1 forwards request bodies with duplex=half", async () => {
    const response = await request("/functions/v1/hello", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-project-ref": "proj_1",
      },
      body: JSON.stringify({ ping: true }),
    });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:9000/hello");
    expect(calls[0]?.init?.duplex).toBe("half");
  });

  test("auth proxy resolves tenant ports from projects.config", async () => {
    const sqlSpy = spyOn(dbModule, "sql");
    sqlSpy.mockImplementation(async (...args: unknown[]) => {
      const text = String(args[0] ?? "");
      if (text.includes("FROM projects")) {
        return [{
          config: {
            postgrest_port: 7361,
            gotrue_port: 8361,
          },
        }];
      }
      return [];
    });

    const response = await request("/auth/v1/health", {
      method: "GET",
      headers: {
        "x-project-ref": "proj_1",
      },
    });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8361/health");
    sqlSpy.mockRestore();
  });

  test("auth proxy resolves project ref from forwarded custom API host", async () => {
    const sqlSpy = spyOn(dbModule, "sql");
    sqlSpy.mockImplementation(async (...args: unknown[]) => {
      const text = String(args[0] ?? "");
      if (text.includes("SELECT ref")) {
        return [{ ref: "proj_1" }];
      }
      if (text.includes("SELECT config")) {
        return [{
          config: {
            postgrest_port: 7361,
            gotrue_port: 8361,
          },
        }];
      }
      return [];
    });

    const response = await request("/auth/v1/health", {
      method: "GET",
      headers: {
        "x-forwarded-host": "api.aorist.net",
      },
    });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8361/health");
    sqlSpy.mockRestore();
  });
});
