// @supacloud-test-isolate
import { afterEach, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { Elysia } from "elysia";
import { CaddyGatewayProvider } from "../../src/services/gateway.service";
import {
    POSTRUST_GRAPHQL_EVALUATION_ENV,
    POSTRUST_GRAPHQL_EVALUATION_PATHS,
    POSTRUST_GRAPHQL_UPSTREAM_URI,
    postrustGraphqlEvaluationEnabled,
} from "../../src/services/postrust-graphql-evaluation";
import { sdkProxyInternals, sdkProxyRoutes, setSdkProxyFetchForTests, setSdkProxySqlForTests } from "../../src/routes/sdk-proxy";

const PUBLISHED_POSTRUST_PATHS = [
    "/api/graphql",
    "/v1/graphql",
    "/v1alpha1/graphql",
    "/v1/graphql/ws",
    "/admin/graphql",
    "/internal/postrust/graphql/ws",
];

type LoadedRoute = {
    "@id"?: string;
    match?: Array<{ path?: string[] }>;
    handle?: Array<Record<string, unknown>>;
};

const spies: Array<{ mockRestore(): void }> = [];

afterEach(async () => {
    delete process.env[POSTRUST_GRAPHQL_EVALUATION_ENV];
    setSdkProxyFetchForTests();
    setSdkProxySqlForTests();
    for (const spy of spies.splice(0)) spy.mockRestore();
    await rm("/tmp/supacloud-caddy-test", { recursive: true, force: true });
});

function captureFetch(calls: Array<{ url: string; method: string; body: unknown }>) {
    const originalFetch = globalThis.fetch;
    let loadedConfig: { apps?: { http?: { servers?: { supacloud?: { routes?: LoadedRoute[] } } } } } | null = null;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const method = init?.method || "GET";
        let body: unknown = null;
        if (typeof init?.body === "string" && init.body.length > 0) {
            body = JSON.parse(init.body) as unknown;
        }
        calls.push({ url, method, body });
        if (method === "POST" && url.endsWith("/load") && body && typeof body === "object") {
            loadedConfig = body as NonNullable<typeof loadedConfig>;
        }
        if (method === "GET" && url.endsWith("/config/")) {
            return Promise.resolve(Response.json(loadedConfig ?? {}));
        }
        return Promise.resolve(new Response(JSON.stringify({ id: "cert_123", data: [] })));
    }) as typeof fetch;
    return () => {
        globalThis.fetch = originalFetch;
    };
}

function loadedRoutes(calls: Array<{ url: string; method: string; body: unknown }>): LoadedRoute[] {
    const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
    const body = load?.body;
    if (!body || typeof body !== "object") return [];
    const routes = (body as { apps?: { http?: { servers?: { supacloud?: { routes?: LoadedRoute[] } } } } })
        .apps?.http?.servers?.supacloud?.routes;
    return routes ?? [];
}

function rewriteUri(route: LoadedRoute | undefined): string | undefined {
    const rewrite = route?.handle?.find((handler) => handler["handler"] === "rewrite");
    return typeof rewrite?.["uri"] === "string" ? rewrite["uri"] : undefined;
}

function requestHeaders(route: LoadedRoute | undefined): Record<string, unknown> {
    const proxy = route?.handle?.find((handler) => handler["handler"] === "reverse_proxy");
    const headers = proxy?.["headers"];
    if (!headers || typeof headers !== "object") return {};
    const request = (headers as { request?: { set?: Record<string, unknown> } }).request?.set;
    return request ?? {};
}

async function renderProject(ref = "evalref"): Promise<LoadedRoute[]> {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const restore = captureFetch(calls);
    try {
        const result = await new CaddyGatewayProvider().setupUpstream(ref, 3000, 9999);
        expect(result.success).toBe(true);
        return loadedRoutes(calls);
    } finally {
        restore();
    }
}

test("the evaluation flag is closed unless the value is the exact string true", () => {
    expect(postrustGraphqlEvaluationEnabled(undefined)).toBe(false);
    expect(postrustGraphqlEvaluationEnabled("")).toBe(false);
    expect(postrustGraphqlEvaluationEnabled("false")).toBe(false);
    expect(postrustGraphqlEvaluationEnabled("1")).toBe(false);
    expect(postrustGraphqlEvaluationEnabled("yes")).toBe(false);
    expect(postrustGraphqlEvaluationEnabled("TRUE")).toBe(false);
    expect(postrustGraphqlEvaluationEnabled(" true")).toBe(false);
    expect(postrustGraphqlEvaluationEnabled("true")).toBe(true);
    expect(process.env[POSTRUST_GRAPHQL_EVALUATION_ENV]).toBeUndefined();
    expect(postrustGraphqlEvaluationEnabled()).toBe(false);
});

test("the default project gateway still sends /graphql/v1 to pg_graphql and does not publish Postrust GraphQL", async () => {
    const routes = await renderProject();
    const graphql = routes.find((route) => route["@id"] === "route-project-evalref-graphql");
    const opaque = routes.find((route) => route["@id"] === "route-project-evalref-opaque-graphql");
    expect(graphql?.match?.[0]?.path).toEqual(["/graphql/v1*"]);
    expect(rewriteUri(graphql)).toBe("/rpc/graphql");
    expect(requestHeaders(graphql)["Accept-Profile"]).toEqual(["graphql_public"]);
    expect(requestHeaders(graphql)["Content-Profile"]).toEqual(["graphql_public"]);
    expect(opaque?.match?.[0]?.path).toEqual(["/graphql/v1*"]);
    expect(routes.some((route) => route["@id"] === "route-project-evalref-postrust-graphql")).toBe(false);
    const serialized = JSON.stringify(routes);
    for (const path of [...PUBLISHED_POSTRUST_PATHS, ...POSTRUST_GRAPHQL_EVALUATION_PATHS]) {
        expect(serialized).not.toContain(path);
    }
});

test("the flag does not publish Postrust GraphQL on the project host", async () => {
    process.env[POSTRUST_GRAPHQL_EVALUATION_ENV] = "true";
    const routes = await renderProject();
    const graphql = routes.find((route) => route["@id"] === "route-project-evalref-graphql");
    expect(routes.some((route) => route["@id"] === "route-project-evalref-postrust-graphql")).toBe(false);
    expect(rewriteUri(graphql)).toBe("/rpc/graphql");
    expect(requestHeaders(graphql)["Accept-Profile"]).toEqual(["graphql_public"]);
    const serialized = JSON.stringify(routes);
    for (const path of [...PUBLISHED_POSTRUST_PATHS, ...POSTRUST_GRAPHQL_EVALUATION_PATHS, POSTRUST_GRAPHQL_UPSTREAM_URI]) {
        expect(serialized).not.toContain(path);
    }
});

test("a second project render still leaves the evaluation path off the project host", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const restore = captureFetch(calls);
    try {
        const provider = new CaddyGatewayProvider();
        process.env[POSTRUST_GRAPHQL_EVALUATION_ENV] = "true";
        expect((await provider.setupUpstream("evalref", 3000, 9999)).success).toBe(true);
        delete process.env[POSTRUST_GRAPHQL_EVALUATION_ENV];
        expect((await provider.setupUpstream("evalref", 3000, 9999)).success).toBe(true);
        const routes = loadedRoutes(calls);
        expect(routes.some((route) => route["@id"] === "route-project-evalref-postrust-graphql")).toBe(false);
        expect(rewriteUri(routes.find((route) => route["@id"] === "route-project-evalref-graphql"))).toBe("/rpc/graphql");
        expect(JSON.stringify(routes)).not.toContain(POSTRUST_GRAPHQL_UPSTREAM_URI);
    } finally {
        restore();
    }
});

test("the management listener opens the evaluation path only for a project service_role credential", async () => {
    const forwarded: Array<{ url: string; headers: Headers }> = [];
    spies.push(spyOn(sdkProxyInternals, "resolveProjectRefFromApiKey").mockResolvedValue("evalref"));
    spies.push(spyOn(sdkProxyInternals, "resolveProjectApiKey").mockImplementation(async (candidate: string) => (
        candidate === "service-key"
            ? { ref: "evalref", role: "service_role", kind: "service_role", upstreamKey: "legacy-service-jwt" }
            : null
    )));
    spies.push(spyOn(sdkProxyInternals, "resolveProjectServiceRoleKey").mockResolvedValue("legacy-service-jwt"));
    setSdkProxySqlForTests(async () => [{ config: { postgrest_port: 7361, gotrue_port: 8361 } }]);
    setSdkProxyFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
        forwarded.push({
            url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
            headers: new Headers(init?.headers),
        });
        return Response.json({ data: { __typename: "query" } });
    }) as typeof fetch);
    const app = new Elysia().use(sdkProxyRoutes);
    const headers = { apikey: "fixture", "content-type": "application/json" };
    const body = JSON.stringify({ query: "query { __typename }" });

    const publicGraphql = await app.handle(new Request("http://127.0.0.1/graphql/v1", { method: "POST", headers, body }));
    expect(publicGraphql.status).toBe(200);
    expect(forwarded.map((call) => call.url)).toEqual(["http://127.0.0.1:7361/rpc/graphql"]);
    expect(forwarded[0]?.headers.get("accept-profile")).toBe("graphql_public");
    expect(forwarded[0]?.headers.get("content-profile")).toBe("graphql_public");

    forwarded.length = 0;
    const closed = await app.handle(new Request("http://127.0.0.1/internal/postrust/graphql", { method: "POST", headers, body }));
    expect(closed.status).toBe(404);
    expect(forwarded).toEqual([]);

    process.env[POSTRUST_GRAPHQL_EVALUATION_ENV] = "true";
    for (const path of ["/internal/postrust/graphql", "/v1/graphql", "/api/graphql"]) {
        const response = await app.handle(new Request(`http://127.0.0.1${path}`, {
            method: "POST",
            headers: { ...headers, authorization: "Bearer user.jwt" },
            body,
        }));
        expect(response.status).toBe(path === "/internal/postrust/graphql" ? 401 : 404);
    }
    expect(forwarded).toEqual([]);

    const opened = await app.handle(new Request("http://127.0.0.1/internal/postrust/graphql", {
        method: "POST",
        headers: {
            apikey: "service-key",
            authorization: "Bearer user.jwt",
            "content-type": "application/json",
        },
        body,
    }));
    expect(opened.status).toBe(200);
    expect(forwarded.map((call) => call.url)).toEqual(["http://127.0.0.1:7361/v1/graphql"]);
    expect(forwarded[0]?.headers.get("authorization")).toBe("Bearer user.jwt");
    expect(forwarded[0]?.headers.get("accept-profile")).toBeNull();
    expect(forwarded[0]?.headers.get("content-profile")).toBeNull();
});
