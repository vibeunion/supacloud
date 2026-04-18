import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";
import { sdkProxyRoutes } from "../../src/routes/sdk-proxy";

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
});
