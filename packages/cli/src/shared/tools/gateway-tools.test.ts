import { describe, expect, test } from "bun:test";
import { registerGatewayTools } from "./gateway-tools";
import { parseToolArguments } from "../schema";
import type { ToolSchema } from "../schema";

type Callback = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

function captureGatewayTool(http: Record<string, (...args: any[]) => Promise<any>>, projectRef = "proj") {
    let schema: ToolSchema | undefined;
    let callback: Callback | undefined;
    registerGatewayTools(
        {
            tool(name: string, _description: string, toolSchema: ToolSchema, toolCallback: Callback) {
                if (name !== "gateway") return;
                schema = toolSchema;
                callback = toolCallback;
            },
        } as any,
        http as any,
        { projectRef },
    );
    if (!schema || !callback) throw new Error("gateway tool was not registered");
    return { schema, callback };
}

describe("gateway CLI tool — schema coercion", () => {
    test("parses comma-separated hosts/paths and KEY:VALUE headers from CLI input", () => {
        const { schema } = captureGatewayTool({});
        const parsed = parseToolArguments(schema, {
            action: "upsert_route",
            route_id: "webhook",
            hosts: "api.example.com,api.example.cn",
            paths: "/a/*,/b/*",
            headers: "X-Team:core,X-Trace:1",
        });

        expect(parsed.hosts).toEqual(["api.example.com", "api.example.cn"]);
        expect(parsed.paths).toEqual(["/a/*", "/b/*"]);
        expect(parsed.headers).toEqual({ "X-Team": "core", "X-Trace": "1" });
    });

    test("accepts JSON-array and JSON-object inputs", () => {
        const { schema } = captureGatewayTool({});
        const parsed = parseToolArguments(schema, {
            action: "upsert_route",
            route_id: "webhook",
            hosts: '["api.example.com"]',
            paths: '["/a/*"]',
            headers: '{"X-Team":"core"}',
            managed_upstream: "edge-functions",
        });

        expect(parsed.hosts).toEqual(["api.example.com"]);
        expect(parsed.paths).toEqual(["/a/*"]);
        expect(parsed.headers).toEqual({ "X-Team": "core" });
        expect(parsed.managed_upstream).toBe("edge-functions");
    });
});

describe("gateway CLI tool — actions", () => {
    test("prefers an explicit ref over the auto-linked project", async () => {
        const calls: string[] = [];
        const { callback } = captureGatewayTool({
            get: async (path: string) => {
                calls.push(path);
                return { ok: true, status: 200, data: { routes: [] } };
            },
        }, "default-ref");

        await callback({ action: "routes", ref: "override-ref" });

        expect(calls).toEqual(["/v1/projects/override-ref/gateway/routes"]);
    });

    test("lists custom gateway routes via GET", async () => {
        const calls: string[] = [];
        const { callback } = captureGatewayTool({
            get: async (path: string) => {
                calls.push(path);
                return {
                    ok: true,
                    status: 200,
                    data: { routes: [{ id: "r1", hosts: ["api.example.com"], path: "/webhook/*", managed_upstream: "edge-functions" }] },
                };
            },
        });

        const result = await callback({ action: "routes" });

        expect(calls).toEqual(["/v1/projects/proj/gateway/routes"]);
        expect(result.content[0].text).toContain("r1");
        expect(result.content[0].text).toContain('"managed_upstream": "edge-functions"');
    });

    test("upsert_route posts normalized route JSON (single path collapses to string)", async () => {
        const calls: Array<{ path: string; body: unknown }> = [];
        const { callback } = captureGatewayTool({
            post: async (path: string, body?: unknown) => {
                calls.push({ path, body });
                return { ok: true, status: 200, data: { success: true, route: body } };
            },
        });

        const result = await callback({
            action: "upsert_route",
            route_id: "webhook",
            hosts: ["api.example.com", "api.example.cn"],
            paths: ["/webhook/*"],
            upstream: "10.0.0.5:8080",
            headers: { "X-Team": "core", "X-Trace": "1" },
            priority: 10,
        });

        expect(calls[0].path).toBe("/v1/projects/proj/gateway/routes");
        const body = calls[0].body as Record<string, unknown>;
        expect(body.id).toBe("webhook");
        expect(body.hosts).toEqual(["api.example.com", "api.example.cn"]);
        expect(body.path).toBe("/webhook/*");
        expect(body.upstream).toBe("10.0.0.5:8080");
        expect(body.headers).toEqual({ "X-Team": "core", "X-Trace": "1" });
        expect(body.priority).toBe(10);
        expect(result.content[0].text).toContain("webhook");
    });

    test("upsert_route sends array path when multiple paths given", async () => {
        const calls: Array<{ body: unknown }> = [];
        const { callback } = captureGatewayTool({
            post: async (_path: string, body?: unknown) => {
                calls.push({ body });
                return { ok: true, status: 200, data: { success: true } };
            },
        });

        await callback({
            action: "upsert_route",
            route_id: "multi",
            hosts: ["app.example.com"],
            paths: ["/a/*", "/b/*"],
        });

        expect((calls[0].body as Record<string, unknown>).path).toEqual(["/a/*", "/b/*"]);
    });

    test("upsert_route forwards protocol-scoped redirect fields", async () => {
        const calls: Array<{ body: unknown }> = [];
        const { callback } = captureGatewayTool({
            post: async (_path: string, body?: unknown) => {
                calls.push({ body });
                return { ok: true, status: 200, data: { success: true } };
            },
        });

        await callback({
            action: "upsert_route",
            route_id: "canonical-https",
            hosts: ["www.example.com"],
            paths: ["/*"],
            protocol: "http",
            redirect_to: "https://www.example.com{http.request.uri}",
            redirect_status: 308,
        });

        expect(calls[0].body).toEqual({
            id: "canonical-https",
            hosts: ["www.example.com"],
            path: "/*",
            protocol: "http",
            redirect_to: "https://www.example.com{http.request.uri}",
            redirect_status: 308,
        });
    });

    test("update_route forwards the managed upstream with the routeId path param", async () => {
        const calls: Array<{ path: string; body: unknown }> = [];
        const { callback } = captureGatewayTool({
            put: async (path: string, body?: unknown) => {
                calls.push({ path, body });
                return { ok: true, status: 200, data: { success: true } };
            },
        });

        await callback({
            action: "update_route",
            route_id: "webhook",
            hosts: ["api.example.com"],
            paths: ["/webhook/*"],
            managed_upstream: "edge-functions",
        });

        expect(calls[0].path).toBe("/v1/projects/proj/gateway/routes/webhook");
        const body = calls[0].body as Record<string, unknown>;
        expect(body.managed_upstream).toBe("edge-functions");
        expect(body.id).toBeUndefined();
    });

    test("delete_route calls DELETE with routeId", async () => {
        const calls: string[] = [];
        const { callback } = captureGatewayTool({
            delete: async (path: string) => {
                calls.push(path);
                return { ok: true, status: 200, data: { success: true, deleted: true } };
            },
        });

        await callback({ action: "delete_route", route_id: "webhook" });
        expect(calls).toEqual(["/v1/projects/proj/gateway/routes/webhook"]);
    });

    test("config forwards only provided fields", async () => {
        const calls: Array<{ body: unknown }> = [];
        const { callback } = captureGatewayTool({
            post: async (_path: string, body?: unknown) => {
                calls.push({ body });
                return { ok: true, status: 200, data: { success: true, message: "ok" } };
            },
        });

        await callback({ action: "config", rate_limit_tier: "pro" });
        expect(calls[0].body).toEqual({ rate_limit_tier: "pro" });
    });

    test("config rejects empty body", async () => {
        const { callback } = captureGatewayTool({ post: async () => ({ ok: true, status: 200, data: {} }) });
        await expect(callback({ action: "config" })).rejects.toThrow("required");
    });

    test("rebuild appends clean query flag", async () => {
        const calls: string[] = [];
        const { callback } = captureGatewayTool({
            post: async (path: string) => {
                calls.push(path);
                return { ok: true, status: 200, data: { success: true, updated: 3, clean: true } };
            },
        });

        await callback({ action: "rebuild", clean: true });
        expect(calls).toEqual(["/v1/projects/proj/gateway/rebuild-all?clean=true"]);
    });

    test("deploy_certificate requires cert and key", async () => {
        const { callback } = captureGatewayTool({ post: async () => ({ ok: true, status: 200, data: {} }) });
        await expect(callback({ action: "deploy_certificate" })).rejects.toThrow("cert");
    });

    test("custom_hostname set/get/verify/delete hit correct endpoints", async () => {
        const calls: Array<{ method: string; path: string; body?: unknown }> = [];
        const { callback } = captureGatewayTool({
            get: async (path: string) => { calls.push({ method: "GET", path }); return { ok: true, status: 200, data: {} }; },
            post: async (path: string, body?: unknown) => { calls.push({ method: "POST", path, body }); return { ok: true, status: 200, data: {} }; },
            delete: async (path: string) => { calls.push({ method: "DELETE", path }); return { ok: true, status: 200, data: {} }; },
        });

        await callback({ action: "set_custom_hostname", custom_hostname: "app.example.com" });
        await callback({ action: "custom_hostname" });
        await callback({ action: "verify_custom_hostname" });
        await callback({ action: "delete_custom_hostname" });

        expect(calls).toContainEqual({ method: "POST", path: "/v1/projects/proj/custom-hostname", body: { custom_hostname: "app.example.com" } });
        expect(calls).toContainEqual({ method: "GET", path: "/v1/projects/proj/custom-hostname" });
        expect(calls).toContainEqual({ method: "POST", path: "/v1/projects/proj/custom-hostname/verify" });
        expect(calls).toContainEqual({ method: "DELETE", path: "/v1/projects/proj/custom-hostname" });
    });

    test("ref override works when no projectRef default", async () => {
        const calls: string[] = [];
        // Do not pass projectRef, simulating --ref override when project is not auto-associated
        let callback: Callback | undefined;
        registerGatewayTools(
            { tool: (_n: string, _d: string, _s: Record<string, unknown>, cb: Callback) => { callback = cb; } } as any,
            { get: async (path: string) => { calls.push(path); return { ok: true, status: 200, data: { routes: [] } }; } } as any,
            {},
        );
        if (!callback) throw new Error("gateway tool was not registered");

        await callback({ action: "routes", ref: "otherproj" });
        expect(calls).toEqual(["/v1/projects/otherproj/gateway/routes"]);
    });
});
