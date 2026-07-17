import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { registerGatewayTools } from "./gateway-tools";

type Callback = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

function captureGatewayTool(http: Record<string, (...args: any[]) => Promise<any>>) {
    let schema: Record<string, unknown> | undefined;
    let callback: Callback | undefined;
    registerGatewayTools(
        {
            tool(name: string, _description: string, toolSchema: Record<string, unknown>, toolCallback: Callback) {
                if (name !== "gateway") return;
                schema = toolSchema;
                callback = toolCallback;
            },
        } as any,
        http as any,
    );
    if (!schema || !callback) throw new Error("gateway tool was not registered");
    return { schema, callback };
}

describe("admin gateway CLI tool", () => {
    test("requires ref when no projectRef default (admin always needs explicit ref)", async () => {
        const { callback } = captureGatewayTool({
            get: async () => ({ ok: true, status: 200, data: { routes: [] } }),
        });

        await expect(callback({ action: "routes" })).rejects.toThrow("'ref' is required");
    });

    test("lists routes with explicit ref", async () => {
        const calls: string[] = [];
        const { callback } = captureGatewayTool({
            get: async (path: string) => { calls.push(path); return { ok: true, status: 200, data: { routes: [{ id: "r1" }] } }; },
        });

        const result = await callback({ action: "routes", ref: "tenant-a" });
        expect(calls).toEqual(["/v1/projects/tenant-a/gateway/routes"]);
        expect(result.content[0].text).toContain("r1");
    });

    test("upsert_route posts normalized JSON with single path as string", async () => {
        const calls: Array<{ path: string; body: unknown }> = [];
        const { callback } = captureGatewayTool({
            post: async (path: string, body?: unknown) => { calls.push({ path, body }); return { ok: true, status: 200, data: { success: true } }; },
        });

        await callback({
            action: "upsert_route",
            ref: "tenant-a",
            route_id: "webhook",
            hosts: ["api.example.com"],
            paths: ["/webhook/*"],
            upstream: "10.0.0.5:8080",
        });

        expect(calls[0].path).toBe("/v1/projects/tenant-a/gateway/routes");
        const body = calls[0].body as Record<string, unknown>;
        expect(body.path).toBe("/webhook/*");
        expect(body.upstream).toBe("10.0.0.5:8080");
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
            ref: "tenant-a",
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

    test("rebuild clean appends query flag", async () => {
        const calls: string[] = [];
        const { callback } = captureGatewayTool({
            post: async (path: string) => { calls.push(path); return { ok: true, status: 200, data: { success: true } }; },
        });

        await callback({ action: "rebuild", ref: "tenant-a", clean: true });
        expect(calls).toEqual(["/v1/projects/tenant-a/gateway/rebuild-all?clean=true"]);
    });

    test("schema coercion handles comma-separated hosts/paths", () => {
        const { schema } = captureGatewayTool({});
        const parsed = z.object(schema as any).parse({
            action: "upsert_route",
            ref: "tenant-a",
            route_id: "webhook",
            hosts: "a.com,b.com",
            paths: "/x/*,/y/*",
        });
        expect(parsed.hosts).toEqual(["a.com", "b.com"]);
        expect(parsed.paths).toEqual(["/x/*", "/y/*"]);
    });
});
