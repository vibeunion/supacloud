import { describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import {
    sdkProxyInternals,
    sdkProxyRoutes,
    setSdkProxyFetchForTests,
    setSdkProxySqlForTests,
} from "../../src/routes/sdk-proxy";
import {
    BLOCKED_POSTRUST_REST_PATH_REGEXP,
    applyPublicColumnsQueryRewrite,
    isBlockedPostrustUpstreamPath,
    normalizePostgrestColumnsParam,
} from "../../src/services/postrust-rest-guard";

describe("Postrust columns parameter", () => {
    test("strips the quotes supabase-js adds around bulk-insert column names", () => {
        expect(normalizePostgrestColumnsParam("\"task\",\"is_complete\"")).toBe("task,is_complete");
        expect(normalizePostgrestColumnsParam("task,is_complete")).toBe("task,is_complete");
        expect(normalizePostgrestColumnsParam("\"a\"\"b\"")).toBe("a\"b");
    });

    test("the public Caddy columns rewrite matches the proxy helper", () => {
        for (const value of [
            "\"task\",\"is_complete\"",
            "task,is_complete",
            "\"a\"\"b\"",
            "\"a\"\"b\",\"c\"",
            " \"task\" , \"is_complete\" ",
        ]) {
            expect(applyPublicColumnsQueryRewrite(value)).toBe(normalizePostgrestColumnsParam(value));
        }
    });
});

describe("Postrust private surfaces", () => {
    test("refuses admin, custom routes, and Hasura GraphQL after the /rest/v1 strip", () => {
        for (const path of [
            "/admin",
            "/admin/",
            "/admin/openapi.json",
            "/admin/swagger",
            "/admin/scalar",
            "/admin/graphql",
            "/_",
            "/_/health",
            "/api/graphql",
            "/api/graphql/ws",
            "/v1/graphql",
            "/v1alpha1/graphql",
            "/foo/../admin",
            "/api/graphql/../graphql",
            "/rpc/graphql",
            "/rpc/graphql/",
            "/RPC/GraphQL",
            "/rpc/graphql/extra",
        ]) {
            expect(isBlockedPostrustUpstreamPath(path)).toBe(true);
        }
        for (const path of ["/users", "/administrator", "/api/users", "/v1", "/rpc/other", "/rpc/graphql_public"]) {
            expect(isBlockedPostrustUpstreamPath(path)).toBe(false);
        }
    });

    test("the public Caddy regexp matches the same suffixes the proxy refuses", () => {
        const pattern = new RegExp(BLOCKED_POSTRUST_REST_PATH_REGEXP);
        for (const path of [
            "/rest/v1/admin",
            "/rest/v1/admin/",
            "/rest/v1/admin/openapi.json",
            "/rest/v1/admin/swagger",
            "/rest/v1/admin/scalar",
            "/rest/v1/admin/graphql",
            "/rest/v1/_",
            "/rest/v1/_/health",
            "/rest/v1/api/graphql",
            "/rest/v1/api/graphql/ws",
            "/rest/v1/v1/graphql",
            "/rest/v1/v1alpha1/graphql",
            "/rest/v1/rpc/graphql",
            "/rest/v1/rpc/graphql/",
            "/rest/v1/RPC/GraphQL",
        ]) {
            expect(pattern.test(path)).toBe(true);
        }
        for (const path of [
            "/rest/v1/users",
            "/rest/v1/administrator",
            "/rest/v1/api/users",
            "/rest/v1/v1",
            "/rest/v1/rpc/other",
            "/graphql/v1",
        ]) {
            expect(pattern.test(path)).toBe(false);
        }
    });
});

describe("public REST proxy", () => {
    test("rewrites quoted columns and does not forward blocked Postrust paths", async () => {
        const calls: string[] = [];
        const resolveKey = spyOn(sdkProxyInternals, "resolveProjectRefFromApiKey").mockResolvedValue("proj_1");
        const resolveApiKey = spyOn(sdkProxyInternals, "resolveProjectApiKey").mockResolvedValue({
            ref: "proj_1",
            kind: "publishable",
            role: "anon",
            upstreamKey: "legacy-anon-jwt",
        });
        setSdkProxySqlForTests(async (query) => {
            const text = String(query?.[0] ?? "");
            if (text.includes("SELECT config")) {
                return [{ config: { postgrest_port: 7361, gotrue_port: 8361 } }];
            }
            return [];
        });
        setSdkProxyFetchForTests(((input: string | URL | Request) => {
            calls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
            return Promise.resolve(new Response("[]", { headers: { "Content-Type": "application/json" } }));
        }) as typeof fetch);
        const app = new Elysia().use(sdkProxyRoutes);
        try {
            const inserted = await app.handle(new Request(
                "http://localhost/rest/v1/todos?columns=%22task%22%2C%22is_complete%22",
                {
                    method: "POST",
                    headers: {
                        apikey: "sb_publishable_client_key",
                        "content-type": "application/json",
                    },
                    body: JSON.stringify([
                        { task: "order-a", is_complete: false },
                        { task: "order-b", is_complete: true },
                    ]),
                },
            ));
            expect(inserted.status).toBe(200);
            expect(calls).toEqual(["http://127.0.0.1:7361/todos?columns=task%2Cis_complete"]);

            calls.length = 0;
            const admin = await app.handle(new Request("http://localhost/rest/v1/admin/openapi.json", {
                headers: { apikey: "sb_publishable_client_key" },
            }));
            expect(admin.status).toBe(404);
            expect(await admin.json()).toEqual({ message: "Not found" });
            const graphql = await app.handle(new Request("http://localhost/rest/v1/api/graphql", {
                method: "POST",
                headers: { apikey: "sb_publishable_client_key", "content-type": "application/json" },
                body: "{\"query\":\"{ __typename }\"}",
            }));
            expect(graphql.status).toBe(404);
            expect(calls).toEqual([]);
        } finally {
            resolveKey.mockRestore();
            resolveApiKey.mockRestore();
            setSdkProxyFetchForTests();
            setSdkProxySqlForTests();
        }
    });
});
