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

function captureSecretsTool(
    http: Record<string, unknown>,
    environment: NodeJS.ProcessEnv = {},
) {
    let schema: ToolSchema | undefined;
    let callback: ((args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) | undefined;
    registerAdvancedTools({
        tool(name: string, _description: string, toolSchema: ToolSchema, toolCallback: typeof callback) {
            if (name !== "secrets") return;
            schema = toolSchema;
            callback = toolCallback;
        },
    }, http as any, environment);

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

    test("rejects an unconfirmed bundle policy without a follow-up PATCH", async () => {
        const calls: Array<{ method: string; path: string; body: unknown }> = [];
        const { callback } = captureEdgeFunctionsTool({
            post: async (path: string, body: unknown) => {
                calls.push({ method: "post", path, body });
                return { ok: true, status: 200, data: { success: true } };
            },
            patch: async (path: string, body: unknown) => {
                calls.push({ method: "patch", path, body });
                throw new Error("deploy must not patch policy after activation");
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
        ]);
        expect(response.content[0].text).toStartWith("❌ Unsafe deployment receipt");
        expect(response.content[0].text).toContain("did not confirm the requested function policy");
        expect(response.content[0].text).toContain("No follow-up PATCH was attempted");
        expect(response.content[0].text).toContain("code and policy must be activated atomically");
    });

    test("rejects a mismatched single-file policy without a follow-up PATCH", async () => {
        const calls: Array<{ method: string; path: string }> = [];
        const { callback } = captureEdgeFunctionsTool({
            post: async (path: string) => {
                calls.push({ method: "post", path });
                return { ok: true, status: 200, data: { success: true, verify_jwt: true } };
            },
            patch: async (path: string) => {
                calls.push({ method: "patch", path });
                throw new Error("deploy must not patch policy after activation");
            },
        });

        const response = await callback({
            action: "deploy",
            ref: "proj",
            slug: "public-hook-mismatch",
            code: "export default { fetch: () => new Response('ok') }",
            verify_jwt: false,
        });

        expect(calls).toEqual([
            { method: "post", path: "/v1/projects/proj/functions/public-hook-mismatch" },
        ]);
        expect(response.content[0].text).toStartWith("❌ Unsafe deployment receipt");
        expect(response.content[0].text).toContain("No follow-up PATCH was attempted");
    });
});

describe("secrets CLI tool", () => {
    test("fails closed without echoing the response body when listing secrets fails", async () => {
        const responseBodySentinel = "server-secret-shaped-error-sentinel";
        const { callback } = captureSecretsTool({
            get: async () => ({
                ok: false,
                status: 503,
                data: { error: responseBodySentinel },
            }),
        });

        const response = await callback({ action: "list", ref: "proj" });

        expect(response.content[0].text).toBe("❌ Failed (503)");
        expect(response.content[0].text).not.toContain(responseBodySentinel);
    });

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

    test("parses explicit environment variable names from the kebab-case flag", () => {
        const { schema } = captureSecretsTool({});
        const parsed = parseToolArguments(schema, {
            action: "upsert",
            ref: "proj",
            "from-env": " API_KEY,WEBHOOK_SECRET ",
        });

        expect(parsed["from-env"]).toEqual(["API_KEY", "WEBHOOK_SECRET"]);
    });

    test.each([
        ["empty entries", "API_KEY,,WEBHOOK_SECRET", "non-empty comma-separated list"],
        ["invalid names", "API-KEY", "Invalid environment secret name 'API-KEY'"],
        ["overlong names", `A${"B".repeat(256)}`, "Invalid environment secret name"],
        ["duplicate names", "API_KEY,API_KEY", "Duplicate environment secret name 'API_KEY'"],
    ])("rejects %s before resolving environment values", (_label, names, expectedMessage) => {
        const { schema } = captureSecretsTool({});

        expect(() => parseToolArguments(schema, {
            action: "upsert",
            ref: "proj",
            "from-env": names,
        })).toThrow(expectedMessage);
    });

    test("reads secret values from the CLI environment without echoing them", async () => {
        const requests: Array<{ path: string; body: unknown }> = [];
        const primarySecret = "unit-primary-secret-sentinel";
        const secondarySecret = "unit-secondary-secret-sentinel";
        const { callback } = captureSecretsTool({
            post: async (path: string, body: unknown) => {
                requests.push({ path, body });
                return { ok: true, status: 200, data: {} };
            },
        }, {
            API_KEY: primarySecret,
            WEBHOOK_SECRET: secondarySecret,
        });

        const response = await callback({
            action: "upsert",
            ref: "proj",
            "from-env": ["API_KEY", "WEBHOOK_SECRET"],
        });

        expect(requests).toEqual([{
            path: "/v1/projects/proj/secrets",
            body: [
                { name: "API_KEY", value: primarySecret },
                { name: "WEBHOOK_SECRET", value: secondarySecret },
            ],
        }]);
        expect(response.content[0].text).toBe("✅ Updated 2 secrets");
        expect(response.content[0].text).not.toContain(primarySecret);
        expect(response.content[0].text).not.toContain(secondarySecret);
    });

    test.each([
        ["missing", {}],
        ["empty", { API_KEY: "" }],
    ])("fails closed when an environment value is %s", async (_label, environment) => {
        let requestCount = 0;
        const { callback } = captureSecretsTool({
            post: async () => {
                requestCount += 1;
                return { ok: true, status: 200, data: {} };
            },
        }, environment);

        await expect(callback({
            action: "upsert",
            ref: "proj",
            "from-env": ["API_KEY"],
        })).rejects.toThrow("Environment variable 'API_KEY' must be set to a non-empty value");
        expect(requestCount).toBe(0);
    });

    test("rejects mixed from-env and inline inputs before HTTP", async () => {
        let requestCount = 0;
        const inlineSecret = "unit-inline-secret-sentinel";
        const { callback } = captureSecretsTool({
            post: async () => {
                requestCount += 1;
                return { ok: true, status: 200, data: {} };
            },
        }, { API_KEY: "unit-environment-secret-sentinel" });

        await expect(callback({
            action: "upsert",
            ref: "proj",
            secrets: [{ name: "INLINE_KEY", value: inlineSecret }],
            "from-env": ["API_KEY"],
        })).rejects.toThrow("'--from-env' cannot be combined with '--secrets'");
        expect(requestCount).toBe(0);
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
