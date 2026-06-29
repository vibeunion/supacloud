import { afterEach, describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";
import { config } from "../../src/config";
import { grafanaProxyInternals, grafanaProxyRoutes } from "../../src/routes/grafana";

const app = new Elysia().use(grafanaProxyRoutes);
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("grafana proxy routes", () => {
  test("strips the /grafana mount prefix when proxying to the local Grafana root", () => {
    const target = grafanaProxyInternals.buildGrafanaTargetUrl(
      "https://studio.example.com/grafana/d/pgsql-overview?orgId=1",
    );

    expect(target.toString()).toBe("http://127.0.0.1:3000/d/pgsql-overview?orgId=1");
  });

  test("proxies Grafana responses before the SPA catch-all can handle them", async () => {
    const seen: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response("grafana", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }) as unknown as typeof fetch;

    const response = await app.handle(
      new Request("https://studio.example.com/grafana/api/search?query=pgsql", {
        headers: { authorization: `Bearer ${config.masterToken}` },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("grafana");
    expect(seen[0]).toBe("http://127.0.0.1:3000/api/search?query=pgsql");
  });

  test("requires management API auth before proxying Grafana", async () => {
    let called = false;
    globalThis.fetch = mock(async () => {
      called = true;
      return new Response("unexpected upstream call");
    }) as unknown as typeof fetch;

    const response = await app.handle(
      new Request("https://studio.example.com/grafana/api/search?query=pgsql"),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Missing Authorization header" });
    expect(called).toBe(false);
  });
});
