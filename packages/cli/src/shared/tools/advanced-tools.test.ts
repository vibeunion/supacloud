import { describe, expect, test } from "bun:test";
import { registerAdvancedTools } from "./advanced-tools";
import { parseToolArguments } from "../schema";
import type { ToolSchema } from "../schema";

function captureEdgeFunctionsTool(http: Record<string, unknown>) {
    let schema: ToolSchema | undefined;
    let callback: ((args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) | undefined;
    registerAdvancedTools({
        tool(name: string, _description: string, toolSchema: ToolSchema, toolCallback: typeof callback) {
            if (name !== "edge_functions") return;
            schema = toolSchema;
            callback = toolCallback;
        },
    }, http as any);

    if (!schema || !callback) throw new Error("edge_functions tool was not registered");
    return { schema, callback };
}

function captureSecretsTool(http: Record<string, unknown>) {
    let schema: ToolSchema | undefined;
    let callback: ((args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) | undefined;
    registerAdvancedTools({
        tool(name: string, _description: string, toolSchema: ToolSchema, toolCallback: typeof callback) {
            if (name !== "secrets") return;
            schema = toolSchema;
            callback = toolCallback;
        },
    }, http as any);

    if (!schema || !callback) throw new Error("secrets tool was not registered");
    return { schema, callback };
}

function captureTaskEventsTool(http: Record<string, unknown>) {
    let schema: ToolSchema | undefined;
    let callback: ((args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) | undefined;
    registerAdvancedTools({
        tool(name: string, _description: string, toolSchema: ToolSchema, toolCallback: typeof callback) {
            if (name !== "task_events") return;
            schema = toolSchema;
            callback = toolCallback;
        },
    }, http as any);

    if (!schema || !callback) throw new Error("task_events tool was not registered");
    return { schema, callback };
}

describe("edge_functions CLI tool", () => {
    test("parses a bundle file map from a CLI JSON string", () => {
        const { schema } = captureEdgeFunctionsTool({});
        const parsed = parseToolArguments(schema, {
            action: "deploy_bundle",
            ref: "proj",
            slug: "worker",
            files: '{"index.ts":"export default {}","_shared/http.ts":"export const ok = true"}',
        });

        expect(parsed.files).toEqual({
            "index.ts": "export default {}",
            "_shared/http.ts": "export const ok = true",
        });
    });

    test("returns a friendly error for invalid bundle file JSON", () => {
        const { schema } = captureEdgeFunctionsTool({});
        expect(() => parseToolArguments(schema, {
            action: "deploy_bundle",
            ref: "proj",
            slug: "worker",
            files: "{invalid",
        })).toThrow("Invalid files JSON object");
    });

    test("parses background routes from CLI-friendly comma-separated input", () => {
        const { schema } = captureEdgeFunctionsTool({});
        const parsed = parseToolArguments(schema, {
            action: "config",
            ref: "proj",
            slug: "render",
            verify_jwt: false,
            background_routes: "/queue/*,/render/*",
        });

        expect(parsed.background_routes).toEqual(["/queue/*", "/render/*"]);
    });

    test("parses background routes from JSON array input", () => {
        const { schema } = captureEdgeFunctionsTool({});
        const parsed = parseToolArguments(schema, {
            action: "config",
            ref: "proj",
            slug: "render",
            background_routes: '["/queue/*","/render/*"]',
        });

        expect(parsed.background_routes).toEqual(["/queue/*", "/render/*"]);
    });

    test("returns a friendly error for invalid background route JSON", () => {
        const { schema } = captureEdgeFunctionsTool({});
        expect(() => parseToolArguments(schema, {
            action: "config",
            ref: "proj",
            slug: "render",
            background_routes: "[invalid",
        })).toThrow("Invalid background_routes JSON array");
    });

    test("updates Edge Function config through the management API", async () => {
        const calls: Array<{ path: string; body: unknown }> = [];
        const { callback } = captureEdgeFunctionsTool({
            patch: async (path: string, body: unknown) => {
                calls.push({ path, body });
                return { ok: true, status: 200, data: { verify_jwt: false, background_routes: ["/queue/*"] } };
            },
        });

        const result = await callback({
            action: "config",
            ref: "proj",
            slug: "render",
            verify_jwt: false,
            background_routes: ["/queue/*"],
        });

        expect(calls).toEqual([
            {
                path: "/v1/projects/proj/functions/render/config",
                body: { verify_jwt: false, background_routes: ["/queue/*"] },
            },
        ]);
        expect(result.content[0].text).toContain("Function render config updated");
    });

    test("sends bundle config inline without a follow-up PATCH", async () => {
        const calls: Array<{ method: string; path: string; body: unknown }> = [];
        const { callback } = captureEdgeFunctionsTool({
            post: async (path: string, body: unknown) => {
                calls.push({ method: "post", path, body });
                return {
                    ok: true,
                    status: 200,
                    data: { success: true, verify_jwt: true, background_routes: ["/work/*"] },
                };
            },
        });

        const result = await callback({
            action: "deploy_bundle",
            ref: "proj",
            slug: "worker",
            files: { "index.ts": "export default {}" },
            verify_jwt: true,
            background_routes: ["/work/*"],
        });

        expect(calls).toEqual([
            {
                method: "post",
                path: "/v1/projects/proj/functions/worker/bundle",
                body: {
                    files: { "index.ts": "export default {}" },
                    entrypoint: undefined,
                    minify: undefined,
                    verify_jwt: true,
                    background_routes: ["/work/*"],
                },
            },
        ]);
        expect(result.content[0].text).toContain("Function worker bundle deployed");
    });

    test("sends single-file config inline without a follow-up PATCH", async () => {
        const calls: Array<{ method: string; path: string; body: unknown }> = [];
        const { callback } = captureEdgeFunctionsTool({
            post: async (path: string, body: unknown) => {
                calls.push({ method: "post", path, body });
                return { ok: true, status: 200, data: { success: true, verify_jwt: false } };
            },
        });

        const result = await callback({
            action: "deploy",
            ref: "proj",
            slug: "public-hook",
            code: "export default { fetch: () => new Response('ok') }",
            verify_jwt: false,
        });

        expect(calls).toEqual([{
            method: "post",
            path: "/v1/projects/proj/functions/public-hook",
            body: {
                code: "export default { fetch: () => new Response('ok') }",
                minify: undefined,
                verify_jwt: false,
            },
        }]);
        expect(result.content[0].text).toContain("Function public-hook deployed");
    });

    test("uses an explicitly labelled legacy PATCH when an old server omits policy confirmation", async () => {
        const calls: Array<{ method: string; path: string; body: unknown }> = [];
        const { callback } = captureEdgeFunctionsTool({
            post: async (path: string, body: unknown) => {
                calls.push({ method: "post", path, body });
                return { ok: true, status: 200, data: { success: true } };
            },
            patch: async (path: string, body: unknown) => {
                calls.push({ method: "patch", path, body });
                return { ok: true, status: 200, data: { verify_jwt: false } };
            },
        });

        const response = await callback({
            action: "deploy_bundle",
            ref: "proj",
            slug: "legacy-hook",
            files: { "index.ts": "export default {}" },
            verify_jwt: false,
        });

        expect(calls.map(({ method, path }) => ({ method, path }))).toEqual([
            { method: "post", path: "/v1/projects/proj/functions/legacy-hook/bundle" },
            { method: "patch", path: "/v1/projects/proj/functions/legacy-hook/config" },
        ]);
        expect(response.content[0].text).toContain("Legacy non-atomic compatibility path");
    });

    test("reports an unsafe partial deployment when legacy policy PATCH cannot be confirmed", async () => {
        const { callback } = captureEdgeFunctionsTool({
            post: async () => ({ ok: true, status: 200, data: { success: true } }),
            patch: async () => ({ ok: false, status: 503, data: { message: "unavailable" } }),
        });

        const response = await callback({
            action: "deploy_bundle",
            ref: "proj",
            slug: "legacy-hook-fail",
            files: { "index.ts": "export default {}" },
            verify_jwt: false,
        });

        expect(response.content[0].text).toContain("Partial deployment (unsafe)");
        expect(response.content[0].text).toContain("POST succeeded");
        expect(response.content[0].text).toContain("code/bundle was deployed");
        expect(response.content[0].text).toContain("function policy was not confirmed");
        expect(response.content[0].text).toContain("legacy PATCH fallback failed");
        expect(response.content[0].text).not.toContain("Deployment failed");
    });
});

describe("secrets CLI tool", () => {
    test("parses JSON array secrets passed as a CLI string", () => {
        const { schema } = captureSecretsTool({});
        const parsed = parseToolArguments(schema, {
            action: "upsert",
            ref: "proj",
            secrets: '[{"name":"API_KEY","value":"secret"}]',
        });

        expect(parsed.secrets).toEqual([{ name: "API_KEY", value: "secret" }]);
    });

    test("parses comma-separated KEY=VALUE secrets", () => {
        const { schema } = captureSecretsTool({});
        const parsed = parseToolArguments(schema, {
            action: "upsert",
            ref: "proj",
            secrets: "API_KEY=secret,OTHER=value=with=equals",
        });

        expect(parsed.secrets).toEqual([
            { name: "API_KEY", value: "secret" },
            { name: "OTHER", value: "value=with=equals" },
        ]);
    });
});

describe("task_events CLI tool", () => {
    test("registers a task webhook through management api", async () => {
        const calls: Array<{ method: string; path: string; body: unknown }> = [];
        const { callback } = captureTaskEventsTool({
            post: async (path: string, body: unknown) => {
                calls.push({ method: "post", path, body });
                return { ok: true, status: 200, data: { registered: true } };
            },
        });

        const result = await callback({
            action: "register_webhook",
            ref: "proj",
            url: "https://example.com/webhook",
            secret: "secret",
        });

        expect(calls).toEqual([
            {
                method: "post",
                path: "/v1/projects/proj/task-events/webhook",
                body: { url: "https://example.com/webhook", secret: "secret" },
            },
        ]);
        expect(result.content[0].text).toContain("Webhook registered");
    });
});
