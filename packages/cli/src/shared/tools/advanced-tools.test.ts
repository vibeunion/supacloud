import { describe, expect, test } from "bun:test";
import { registerAdvancedTools } from "./advanced-tools";
import { parseToolArguments } from "../schema";
import type { ToolSchema } from "../schema";

function captureEdgeFunctionsTool(
    http: Record<string, unknown>,
    options: { readOnly?: boolean } = {},
) {
    let schema: ToolSchema | undefined;
    let callback: ((args: Record<string, unknown>) => Promise<{
        content: Array<{ text: string }>;
        isError?: boolean;
    }>) | undefined;
    registerAdvancedTools({
        tool(name: string, _description: string, toolSchema: ToolSchema, toolCallback: typeof callback) {
            if (name !== "edge_functions") return;
            schema = toolSchema;
            callback = toolCallback;
        },
    }, http as any, process.env, options);

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

    test("keeps the Function list as a JSON array with numeric active versions", async () => {
        const functions = [{
            slug: "fa-api",
            version: 7,
            verify_jwt: true,
            status: "ACTIVE",
        }];
        const { callback } = captureEdgeFunctionsTool({
            get: async () => ({ ok: true, status: 200, data: functions }),
        });

        const response = await callback({ action: "list", ref: "proj" });
        const payload = JSON.parse(response.content[0].text);

        expect(response.isError).toBeUndefined();
        expect(payload).toEqual(functions);
        expect(typeof payload[0].version).toBe("number");
    });

    test.each([
        ["an object", { slug: "fa-api", version: 7 }],
        ["a non-object entry", ["list-response-sentinel"]],
        ["a missing slug", [{ version: 7, private: "list-response-sentinel" }]],
        ["an invalid slug", [{ slug: "../fa-api", version: 7, private: "list-response-sentinel" }]],
        ["a string version", [{ slug: "fa-api", version: "7", private: "list-response-sentinel" }]],
        ["version zero", [{ slug: "fa-api", version: 0, private: "list-response-sentinel" }]],
        ["a fractional version", [{ slug: "fa-api", version: 1.5, private: "list-response-sentinel" }]],
        ["an unsafe version", [{ slug: "fa-api", version: Number.MAX_SAFE_INTEGER + 1, private: "list-response-sentinel" }]],
        ["duplicate slugs", [{ slug: "fa-api", version: 7 }, { slug: "fa-api", version: 8 }]],
    ])("rejects a Function list containing %s without reflecting it", async (_label, payload) => {
        const { callback } = captureEdgeFunctionsTool({
            get: async () => ({ ok: true, status: 200, data: payload }),
        });

        const response = await callback({ action: "list", ref: "proj" });

        expect(response.isError).toBe(true);
        expect(response.content[0].text).toBe("❌ Edge Function list response is invalid");
        expect(response.content[0].text).not.toContain("sentinel");
    });

    test("projects an exact Function source object", async () => {
        const { callback } = captureEdgeFunctionsTool({
            get: async () => ({
                ok: true,
                status: 200,
                data: { code: "export default {};", private: "source-response-sentinel" },
            }),
        });

        const response = await callback({ action: "source", ref: "proj", slug: "fa-api" });

        expect(response.isError).toBeUndefined();
        expect(JSON.parse(response.content[0].text)).toEqual({ code: "export default {};" });
        expect(response.content[0].text).not.toContain("sentinel");
    });

    test("binds source readback to an immutable version across an active-version ABA", async () => {
        const requestedPaths: string[] = [];
        const activeTransitions = [7];
        let activeVersion = 7;
        const { callback } = captureEdgeFunctionsTool({
            get: async (path: string) => {
                requestedPaths.push(path);
                if (path.endsWith("/versions/7")) {
                    activeVersion = 8;
                    activeTransitions.push(activeVersion);
                    activeVersion = 7;
                    activeTransitions.push(activeVersion);
                    return {
                        ok: true,
                        status: 200,
                        data: { source_code: "export const immutable = 7;", private: "source-response-sentinel" },
                    };
                }
                return {
                    ok: true,
                    status: 200,
                    data: [{ slug: "fa-api", version: activeVersion, verify_jwt: true }],
                };
            },
        });

        const before = await callback({ action: "list", ref: "proj" });
        const source = await callback({ action: "source", ref: "proj", slug: "fa-api", version: "7" });
        const after = await callback({ action: "list", ref: "proj" });

        expect(JSON.parse(before.content[0].text)[0].version).toBe(7);
        expect(JSON.parse(source.content[0].text)).toEqual({ code: "export const immutable = 7;" });
        expect(JSON.parse(after.content[0].text)[0].version).toBe(7);
        expect(activeTransitions).toEqual([7, 8, 7]);
        expect(requestedPaths).toEqual([
            "/v1/projects/proj/functions",
            "/v1/projects/proj/functions/fa-api/versions/7",
            "/v1/projects/proj/functions",
        ]);
        expect(source.content[0].text).not.toContain("sentinel");
    });

    test.each([-1, 0, "0", "01", 1.5, "9007199254740992", true, {}])(
        "rejects invalid immutable source version %j before HTTP dispatch",
        async (version) => {
            let requestCount = 0;
            const { callback } = captureEdgeFunctionsTool({
                get: async () => {
                    requestCount += 1;
                    return { ok: true, status: 200, data: {} };
                },
            });

            await expect(callback({
                action: "source",
                ref: "proj",
                slug: "fa-api",
                version,
            })).rejects.toThrow("canonical positive safe integer");
            expect(requestCount).toBe(0);
        },
    );

    test("rejects a malformed immutable source response without reflecting it", async () => {
        const { callback } = captureEdgeFunctionsTool({
            get: async () => ({
                ok: true,
                status: 200,
                data: { code: "wrong-active-source", private: "version-source-response-sentinel" },
            }),
        });

        const response = await callback({ action: "source", ref: "proj", slug: "fa-api", version: "7" });

        expect(response.isError).toBe(true);
        expect(response.content[0].text).toBe("❌ Edge Function source response is invalid");
        expect(response.content[0].text).not.toContain("sentinel");
    });

    test.each([
        ["free text", "source-response-sentinel"],
        ["an array", [{ code: "source-response-sentinel" }]],
        ["a missing code field", { private: "source-response-sentinel" }],
        ["a non-string code field", { code: 7, private: "source-response-sentinel" }],
    ])("rejects a Function source response containing %s without reflecting it", async (_label, payload) => {
        const { callback } = captureEdgeFunctionsTool({
            get: async () => ({ ok: true, status: 200, data: payload }),
        });

        const response = await callback({ action: "source", ref: "proj", slug: "fa-api" });

        expect(response.isError).toBe(true);
        expect(response.content[0].text).toBe("❌ Edge Function source response is invalid");
        expect(response.content[0].text).not.toContain("sentinel");
    });

    test.each([
        ["list", { action: "list", ref: "../proj" }],
        ["deploy_bundle", {
            action: "deploy_bundle",
            ref: "proj",
            slug: "../hook",
            files: { "index.ts": "export default {}" },
            "expected-active-version": "absent",
        }],
        ["source", { action: "source", ref: "proj", slug: "../hook" }],
    ])("rejects %s path segments before HTTP dispatch", async (_action, args) => {
        let requestCount = 0;
        const request = async () => {
            requestCount += 1;
            return { ok: true, status: 200, data: {} };
        };
        const { callback } = captureEdgeFunctionsTool({ get: request, post: request });

        await expect(callback(args)).rejects.toThrow("invalid");
        expect(requestCount).toBe(0);
    });

    test.each(["deploy", "deploy_bundle", "activate"])(
        "rejects %s without expected-active-version before HTTP dispatch",
        async (action) => {
            let requestCount = 0;
            const { callback } = captureEdgeFunctionsTool({
                post: async () => {
                    requestCount += 1;
                    return { ok: true, status: 200, data: {} };
                },
            });
            const actionInput = action === "deploy"
                ? { action, ref: "proj", slug: "hook", path: "/definitely/missing.ts" }
                : action === "deploy_bundle"
                    ? { action, ref: "proj", slug: "hook", files: { "index.ts": "export default {}" } }
                    : { action, ref: "proj", slug: "hook", version: "2" };

            await expect(callback(actionInput)).rejects.toThrow("--expected-active-version");
            expect(requestCount).toBe(0);
        },
    );

    test.each([0, "0", "01", "9007199254740992"])(
        "rejects invalid expected active version %j during argument parsing",
        (expectedActiveVersion) => {
            const { schema } = captureEdgeFunctionsTool({});
            expect(() => parseToolArguments(schema, {
                action: "activate",
                ref: "proj",
                slug: "hook",
                version: "2",
                "expected-active-version": expectedActiveVersion,
            })).toThrow("Invalid arguments");
        },
    );

    test.each([0, "0", "01", "9007199254740992", true, {}])(
        "rejects direct invalid expected active version %j before HTTP dispatch",
        async (expectedActiveVersion) => {
            let requestCount = 0;
            const { callback } = captureEdgeFunctionsTool({
                post: async () => {
                    requestCount += 1;
                    return { ok: true, status: 200, data: {} };
                },
            });

            await expect(callback({
                action: "deploy_bundle",
                ref: "proj",
                slug: "hook",
                files: { "index.ts": "export default {}" },
                "expected-active-version": expectedActiveVersion,
            })).rejects.toThrow("canonical positive safe integer");
            expect(requestCount).toBe(0);
        },
    );

    test("sends bundle config inline without a follow-up PATCH", async () => {
        const calls: Array<{ method: string; path: string; body: unknown }> = [];
        const { callback } = captureEdgeFunctionsTool({
            post: async (path: string, body: unknown) => {
                calls.push({ method: "post", path, body });
                return {
                    ok: true,
                    status: 200,
                    data: {
                        success: true,
                        project_ref: "proj",
                        slug: "worker",
                        previous_active_version: "absent",
                        active_version: "1",
                        version: "1",
                        config: { version: "1", verify_jwt: true, background_routes: ["/work/*"] },
                    },
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
            "expected-active-version": "absent",
        });

        expect(calls).toEqual([
            {
                method: "post",
                path: "/v1/projects/proj/functions/worker/bundle",
                body: {
                    files: { "index.ts": "export default {}" },
                    entrypoint: undefined,
                    minify: undefined,
                    expected_active_version: "absent",
                    verify_jwt: true,
                    background_routes: ["/work/*"],
                },
            },
        ]);
        expect(JSON.parse(result.content[0].text)).toMatchObject({
            ok: true,
            operation: "edge_functions.deploy_bundle",
            project_ref: "proj",
            slug: "worker",
            previous_active_version: "absent",
            active_version: "1",
        });
    });

    test("sends single-file config inline without a follow-up PATCH", async () => {
        const calls: Array<{ method: string; path: string; body: unknown }> = [];
        const { callback } = captureEdgeFunctionsTool({
            post: async (path: string, body: unknown) => {
                calls.push({ method: "post", path, body });
                return {
                    ok: true,
                    status: 200,
                    data: {
                        success: true,
                        project_ref: "proj",
                        slug: "public-hook",
                        previous_active_version: "3",
                        active_version: "4",
                        version: "4",
                        config: { version: "4", verify_jwt: false },
                    },
                };
            },
        });

        const result = await callback({
            action: "deploy",
            ref: "proj",
            slug: "public-hook",
            code: "export default { fetch: () => new Response('ok') }",
            verify_jwt: false,
            "expected-active-version": "3",
        });

        expect(calls).toEqual([{
            method: "post",
            path: "/v1/projects/proj/functions/public-hook",
            body: {
                code: "export default { fetch: () => new Response('ok') }",
                minify: undefined,
                expected_active_version: "3",
                verify_jwt: false,
            },
        }]);
        expect(JSON.parse(result.content[0].text)).toMatchObject({
            ok: true,
            operation: "edge_functions.deploy",
            project_ref: "proj",
            slug: "public-hook",
            previous_active_version: "3",
            active_version: "4",
        });
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
            "expected-active-version": "1",
        });

        expect(calls.map(({ method, path }) => ({ method, path }))).toEqual([
            { method: "post", path: "/v1/projects/proj/functions/legacy-hook/bundle" },
        ]);
        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).error).toEqual({
            code: "OUTCOME_UNKNOWN",
            http_status: 200,
        });
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
            "expected-active-version": "1",
        });

        expect(calls).toEqual([
            { method: "post", path: "/v1/projects/proj/functions/public-hook-mismatch" },
        ]);
        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).error).toEqual({
            code: "OUTCOME_UNKNOWN",
            http_status: 200,
        });
    });

    test("rejects version zero in a deploy receipt", async () => {
        const { callback } = captureEdgeFunctionsTool({
            post: async () => ({
                ok: true,
                status: 200,
                data: {
                    success: true,
                    project_ref: "proj",
                    slug: "public-hook",
                    previous_active_version: "absent",
                    active_version: "0",
                    version: "0",
                    config: { version: "0", verify_jwt: true },
                },
            }),
        });

        const response = await callback({
            action: "deploy_bundle",
            ref: "proj",
            slug: "public-hook",
            files: { "index.ts": "export default {}" },
            "expected-active-version": "absent",
        });

        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).error).toEqual({
            code: "OUTCOME_UNKNOWN",
            http_status: 200,
        });
    });

    test("rejects legacy Function version zero before activation dispatch", async () => {
        let requestCount = 0;
        const { callback } = captureEdgeFunctionsTool({
            post: async () => {
                requestCount += 1;
                return { ok: true, status: 200, data: {} };
            },
        });

        await expect(callback({
            action: "activate",
            ref: "proj",
            slug: "public-hook",
            version: 0,
            "expected-active-version": 2,
        })).rejects.toThrow("canonical positive safe integer");
        expect(requestCount).toBe(0);
    });

    test.each([
        ["zero", 0],
        ["a negative", -1],
        ["a fractional", 1.5],
        ["an unsafe integer", "9007199254740992"],
    ])("rejects %s Function version before dispatch", async (_label, version) => {
        const { schema } = captureEdgeFunctionsTool({});

        expect(() => parseToolArguments(schema, {
            action: "activate",
            ref: "proj",
            slug: "public-hook",
            version,
        })).toThrow("Invalid arguments");
    });

    test.each([
        ["HTTP 503 after possible commit", { ok: false, status: 503, data: { error: "private-server-detail" } }, "OUTCOME_UNKNOWN", 503],
        ["HTTP 408 after possible commit", { ok: false, status: 408, data: { error: "private-server-detail" } }, "OUTCOME_UNKNOWN", 408],
        ["explicit HTTP rejection", { ok: false, status: 409, data: { error: "private-server-detail" } }, "HTTP_ERROR", 409],
        ["transport failure", {
            ok: false,
            status: 500,
            data: { error: "private-server-detail" },
            transportError: true,
        }, "OUTCOME_UNKNOWN", null],
        ["malformed success", {
            ok: true,
            status: 200,
            data: { success: true, version: "5" },
        }, "OUTCOME_UNKNOWN", 200],
    ])("fails Function activation closed for %s without echoing response data", async (
        _label,
        activation,
        expectedCode,
        expectedStatus,
    ) => {
        const { callback } = captureEdgeFunctionsTool({ post: async () => activation });

        const response = await callback({
            action: "activate",
            ref: "proj",
            slug: "hook",
            version: "5",
            "expected-active-version": "4",
        });
        const payload = JSON.parse(response.content[0].text);

        expect(response.isError).toBe(true);
        expect(payload.error).toEqual({ code: expectedCode, http_status: expectedStatus });
        expect(response.content[0].text).not.toContain("private-server-detail");
    });

    test("rejects activate-only policy flags before HTTP dispatch", async () => {
        let requestCount = 0;
        const { callback } = captureEdgeFunctionsTool({
            post: async () => {
                requestCount += 1;
                return { ok: true, status: 200, data: {} };
            },
        });

        await expect(callback({
            action: "activate",
            ref: "proj",
            slug: "hook",
            version: "5",
            verify_jwt: false,
            "expected-active-version": "4",
        })).rejects.toThrow("not supported for 'activate'");
        expect(requestCount).toBe(0);
    });

    test("rejects activate path before any local bundle or HTTP work", async () => {
        let requestCount = 0;
        const { callback } = captureEdgeFunctionsTool({
            post: async () => {
                requestCount += 1;
                return { ok: true, status: 200, data: {} };
            },
        });

        await expect(callback({
            action: "activate",
            ref: "proj",
            slug: "hook",
            version: "5",
            path: "/definitely/not/exist/private-source.ts",
        })).rejects.toThrow("'path' is not supported for 'activate'");
        expect(requestCount).toBe(0);
    });

    test("blocks activate in read-only mode before validation or HTTP dispatch", async () => {
        let requestCount = 0;
        const { callback } = captureEdgeFunctionsTool({
            post: async () => {
                requestCount += 1;
                return { ok: true, status: 200, data: {} };
            },
        }, { readOnly: true });

        const response = await callback({
            action: "activate",
            ref: "../unsafe-ref",
            slug: "../unsafe-slug",
            version: "invalid",
            path: "/definitely/not/exist/private-source.ts",
        });

        expect(response.isError).toBe(true);
        expect(response.content[0].text).toContain("read-only");
        expect(requestCount).toBe(0);
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

    test("projects valid masked secret lists without unknown response fields", async () => {
        const unknownFieldSentinel = "unknown-field-secret-sentinel";
        const { callback } = captureSecretsTool({
            get: async () => ({
                ok: true,
                status: 200,
                data: [
                    { name: "API_KEY", value: "********", internal: unknownFieldSentinel },
                    { name: "WEBHOOK_SECRET", value: "********" },
                ],
            }),
        });

        const response = await callback({ action: "list", ref: "proj" });

        expect(JSON.parse(response.content[0].text)).toEqual([
            { name: "API_KEY", value: "********" },
            { name: "WEBHOOK_SECRET", value: "********" },
        ]);
        expect(response.content[0].text).not.toContain(unknownFieldSentinel);
    });

    test.each([
        ["free text", "list-free-text-secret-sentinel"],
        ["object", { error: "list-object-secret-sentinel" }],
        ["plaintext value", [{ name: "API_KEY", value: "plaintext-secret-sentinel" }]],
        ["non-string name", [{ name: 7, value: "********", leak: "non-string-name-sentinel" }]],
        ["dangerous name", [{ name: "API-KEY", value: "********", leak: "dangerous-name-sentinel" }]],
        ["duplicate name", [
            { name: "API_KEY", value: "********" },
            { name: "API_KEY", value: "********", leak: "duplicate-name-sentinel" },
        ]],
        ["too many entries", Array.from({ length: 1025 }, (_, index) => ({
            name: `KEY_${index}`,
            value: "********",
            leak: index === 0 ? "too-many-entries-sentinel" : undefined,
        }))],
        ["oversized response", [{
            name: "API_KEY",
            value: "********",
            leak: `oversized-list-sentinel-${"x".repeat(1024 * 1024)}`,
        }]],
    ])("rejects a 2xx %s secret list without reflecting it", async (_label, payload) => {
        const { callback } = captureSecretsTool({
            get: async () => ({ ok: true, status: 200, data: payload }),
        });

        const response = await callback({ action: "list", ref: "proj" });

        expect(response.content[0].text).toBe("❌ Project secret list response is invalid");
        expect(response.content[0].text).not.toContain("sentinel");
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
        ["empty entries", "API_KEY,,WEBHOOK_SECRET"],
        ["invalid names", "API-KEY-secret-name-sentinel"],
        ["overlong names", `A${"B".repeat(256)}-secret-name-sentinel`],
        ["duplicate names", "API_KEY,API_KEY"],
        ["too many names", Array.from({ length: 1025 }, (_, index) => `KEY_${index}`).join(",")],
    ])("rejects %s without reflecting input", (_label, names) => {
        const { schema } = captureSecretsTool({});

        expect(() => parseToolArguments(schema, {
            action: "upsert",
            ref: "proj",
            "from-env": names,
        })).toThrow("Environment secret names are invalid");

        try {
            parseToolArguments(schema, { action: "upsert", ref: "proj", "from-env": names });
        } catch (error) {
            expect(String(error)).not.toContain("secret-name-sentinel");
        }
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
        })).rejects.toThrow("Environment secret values are missing or exceed safe limits");
        expect(requestCount).toBe(0);
    });

    test("reads each requested environment value exactly once", async () => {
        const reads = new Map<string, number>();
        const environment = new Proxy({ API_KEY: "primary", WEBHOOK_SECRET: "secondary" }, {
            get(target, name: string) {
                reads.set(name, (reads.get(name) ?? 0) + 1);
                return target[name as keyof typeof target];
            },
        });
        const { callback } = captureSecretsTool({
            post: async () => ({ ok: true, status: 200, data: {} }),
        }, environment);

        await callback({
            action: "upsert",
            ref: "proj",
            "from-env": ["API_KEY", "WEBHOOK_SECRET"],
        });

        expect(Object.fromEntries(reads)).toEqual({ API_KEY: 1, WEBHOOK_SECRET: 1 });
    });

    test("accepts an environment value at the exact UTF-8 byte limit", async () => {
        const boundarySecret = "界".repeat(8192);
        let requestBody: unknown;
        const { callback } = captureSecretsTool({
            post: async (_path: string, body: unknown) => {
                requestBody = body;
                return { ok: true, status: 200, data: {} };
            },
        }, { API_KEY: boundarySecret });

        await callback({ action: "upsert", ref: "proj", "from-env": ["API_KEY"] });

        expect(Buffer.byteLength(boundarySecret)).toBe(24 * 1024);
        expect(requestBody).toEqual([{ name: "API_KEY", value: boundarySecret }]);
    });

    test.each([
        ["oversized value", ["API_KEY"], { API_KEY: "x".repeat(24 * 1024 + 1) }],
        ["oversized multibyte value", ["API_KEY"], { API_KEY: "界".repeat(8193) }],
        ["oversized request", Array.from({ length: 1024 }, (_, index) => `KEY_${index}`),
            Object.fromEntries(Array.from({ length: 1024 }, (_, index) => [`KEY_${index}`, "x".repeat(1024)]))],
    ])("rejects an %s before HTTP", async (_label, names, environment) => {
        let requestCount = 0;
        const { callback } = captureSecretsTool({
            post: async () => {
                requestCount += 1;
                return { ok: true, status: 200, data: {} };
            },
        }, environment);

        await expect(callback({ action: "upsert", ref: "proj", "from-env": names }))
            .rejects.toThrow("Environment secret values are missing or exceed safe limits");
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
