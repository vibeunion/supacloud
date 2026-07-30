import { afterEach, describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";
import { config } from "../../src/config";
import {
  grafanaProxyInternals,
  grafanaProxyRoutes,
  handleGrafanaRequest,
} from "../../src/routes/grafana";

const app = new Elysia().use(grafanaProxyRoutes);
// Mirror `registerStaticAssets`: the SPA catch-all is a GET wildcard that
// takes precedence over plugin routes in Elysia, so Grafana requests are
// delegated from the catch-all instead of relying on `.all` route matching.
const appWithStaticFallback = new Elysia()
  .use(grafanaProxyRoutes)
  .get("*", ({ request }) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/grafana" || pathname.startsWith("/grafana/")) {
      return handleGrafanaRequest(request);
    }
    return new Response("studio");
  });
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

  test("proxies Grafana responses delegated from the SPA catch-all", async () => {
    const seen: Request[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return new Response("grafana", {
        status: 200,
        headers: {
          "content-encoding": "gzip",
          "content-length": "999",
          "content-type": "text/plain",
        },
      });
    }) as unknown as typeof fetch;

    const response = await appWithStaticFallback.handle(
      new Request("https://studio.example.com/grafana/api/search?query=pgsql", {
        headers: { authorization: `Bearer ${config.masterToken}` },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("grafana");
    expect(seen[0].url).toBe("http://127.0.0.1:3000/api/search?query=pgsql");
    expect(seen[0].headers.get("accept-encoding")).toBe("identity");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
  });

  test("requires management API auth before proxying Grafana", async () => {
    let called = false;
    globalThis.fetch = mock(async () => {
      called = true;
      return new Response("unexpected upstream call");
    }) as unknown as typeof fetch;

    const response = await appWithStaticFallback.handle(
      new Request("https://studio.example.com/grafana/api/search?query=pgsql"),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Missing Authorization header" });
    expect(called).toBe(false);
  });
});
