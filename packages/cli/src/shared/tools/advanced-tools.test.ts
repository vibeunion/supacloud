import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAdvancedTools } from "./advanced-tools";
import { parseToolArguments } from "../schema";
import type { ToolSchema } from "../schema";

const EXPECTED_ACTIVATION_ID = "a1111111-1111-4111-8111-111111111111";
const COMMITTED_ACTIVATION_ID = "b2222222-2222-4222-8222-222222222222";

function confirmedFunctionMutation(slug: string) {
    return {
        ok: true,
        status: 200,
        data: {
            success: true,
            project_ref: "proj",
            slug,
            previous_active_version: "3",
            expected_activation_id: EXPECTED_ACTIVATION_ID,
            activation_id: COMMITTED_ACTIVATION_ID,
            active_version: "4",
            version: "4",
            config: { version: "4", verify_jwt: false, activation_id: COMMITTED_ACTIVATION_ID },
        },
    };
}

function captureEdgeFunctionsTool(
    http: Record<string, unknown>,
    options: { readOnly?: boolean } = {},
) {
    const releaseMutationHttp = {
        ...http,
        postReleaseMutation: http.postReleaseMutation ?? http.post,
        patchReleaseMutation: http.patchReleaseMutation ?? http.patch,
        deleteReleaseMutation: http.deleteReleaseMutation ?? http.delete,
    };
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
    }, releaseMutationHttp as any, process.env, options);

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
    test("scaffolds an API-only SvelteKit Function without HTTP access", async () => {
        const root = mkdtempSync(join(tmpdir(), "supacloud-sveltekit-scaffold-"));
        const target = join(root, "api");
        let requestCount = 0;
        const { callback } = captureEdgeFunctionsTool({
            post: async () => {
                requestCount += 1;
                throw new Error("unexpected HTTP request");
            },
        });
        try {
            const response = await callback({
                action: "scaffold",
                slug: "api",
                framework: "sveltekit-function",
                path: target,
            });
            expect(requestCount).toBe(0);
            expect(JSON.parse(response.content[0].text)).toMatchObject({
                success: true,
                framework: "sveltekit-function",
                path: target,
            });
            expect(await Bun.file(join(target, "svelte.config.js")).text())
                .toContain("sveltekit-adapter");
            expect(await Bun.file(join(target, "src/routes/+server.ts")).text())
                .toContain("export function GET");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test.each([
        ["elysia", "elysia", "^1.4.30"],
        ["hono", "hono", "^4.13.5"],
    ] as const)("scaffolds installable %s functions", async (framework, dependency, version) => {
        const root = mkdtempSync(join(tmpdir(), `supacloud-${framework}-scaffold-`));
        const target = join(root, "api");
        const { schema, callback } = captureEdgeFunctionsTool({});
        try {
            const args = parseToolArguments(schema, {
                action: "scaffold",
                slug: "api",
                framework,
                path: target,
            });
            await callback(args);
            expect(JSON.parse(await Bun.file(join(target, "package.json")).text()))
                .toMatchObject({ dependencies: { [dependency]: version } });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("rejects a deploy receipt that confirms the wrong framework", async () => {
        const { callback } = captureEdgeFunctionsTool({
            post: async () => ({
                ...confirmedFunctionMutation("api"),
                data: {
                    ...confirmedFunctionMutation("api").data,
                    config: {
                        version: "4",
                        verify_jwt: true,
                        framework: "fetch",
                        activation_id: COMMITTED_ACTIVATION_ID,
                    },
                },
            }),
        });

        const response = await callback({
            action: "deploy",
            ref: "proj",
            slug: "api",
            code: "export default () => new Response('ok');",
            framework: "hono",
            "expected-active-version": "3",
            "expected-activation-id": EXPECTED_ACTIVATION_ID,
        });

        expect(JSON.parse(response.content[0].text)).toMatchObject({
            ok: false,
            operation: "edge_functions.deploy",
            error: { code: "OUTCOME_UNKNOWN" },
        });
    });

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
                return {
                    ok: true,
                    status: 200,
                    data: {
                        success: true,
                        project_ref: "proj",
                        slug: "render",
                        verify_jwt: false,
                        background_routes: ["/queue/*"],
                        expected_activation_id: EXPECTED_ACTIVATION_ID,
                        activation_id: COMMITTED_ACTIVATION_ID,
                    },
                };
            },
        });

        const result = await callback({
            action: "config",
            ref: "proj",
            slug: "render",
            verify_jwt: false,
            background_routes: ["/queue/*"],
            "expected-activation-id": EXPECTED_ACTIVATION_ID,
        });

        expect(calls).toEqual([
            {
                path: "/v1/projects/proj/functions/render/config",
                body: {
                    verify_jwt: false,
                    background_routes: ["/queue/*"],
                    expected_activation_id: EXPECTED_ACTIVATION_ID,
                },
            },
        ]);
        expect(JSON.parse(result.content[0].text)).toMatchObject({
            ok: true,
            operation: "edge_functions.config",
            project_ref: "proj",
            slug: "render",
            activation_id: COMMITTED_ACTIVATION_ID,
        });
    });

    test("projects the Function list without unknown response fields", async () => {
        const unknownFieldSentinel = "function-list-unknown-field-sentinel";
        const functions = [
            {
                slug: "legacy-hook",
                version: 0,
                activation_id: "legacy",
                verify_jwt: true,
                status: "ACTIVE",
                private: unknownFieldSentinel,
            },
            { slug: "fa-api", version: 7, activation_id: EXPECTED_ACTIVATION_ID, verify_jwt: true, status: "ACTIVE" },
        ];
        const { callback } = captureEdgeFunctionsTool({
            get: async () => ({ ok: true, status: 200, data: functions }),
        });

        const response = await callback({ action: "list", ref: "proj" });
        const payload = JSON.parse(response.content[0].text);

        expect(response.isError).toBeUndefined();
        expect(payload).toEqual([
            { slug: "legacy-hook", version: 0, activation_id: "legacy", verify_jwt: true, status: "ACTIVE" },
            { slug: "fa-api", version: 7, activation_id: EXPECTED_ACTIVATION_ID, verify_jwt: true, status: "ACTIVE" },
        ]);
        expect(payload.map(({ version }: { version: number }) => version)).toEqual([0, 7]);
        expect(response.content[0].text).not.toContain(unknownFieldSentinel);
    });

    test("reads a tombstone Function identity without reflecting unknown config fields", async () => {
        const unknownFieldSentinel = "function-config-unknown-field-sentinel";
        const { callback } = captureEdgeFunctionsTool({
            get: async () => ({
                ok: true,
                status: 200,
                data: {
                    project_ref: "proj",
                    slug: "deleted-hook",
                    active_version: "absent",
                    activation_id: EXPECTED_ACTIVATION_ID,
                    verify_jwt: true,
                    background_routes: [],
                    private: unknownFieldSentinel,
                },
            }),
        });

        const response = await callback({ action: "get_config", ref: "proj", slug: "deleted-hook" });

        expect(JSON.parse(response.content[0].text)).toEqual({
            project_ref: "proj",
            slug: "deleted-hook",
            active_version: "absent",
            verify_jwt: true,
            background_routes: [],
            activation_id: EXPECTED_ACTIVATION_ID,
        });
        expect(response.content[0].text).not.toContain(unknownFieldSentinel);
    });

    test.each([
        ["wrong project", { project_ref: "other" }],
        ["wrong slug", { slug: "other-hook" }],
        ["incoherent absent version", { active_version: "absent", version: "1" }],
        ["invalid activation ID", { activation_id: "legacy-invalid" }],
    ])("rejects a get_config response with %s without reflecting it", async (_label, override) => {
        const { callback } = captureEdgeFunctionsTool({
            get: async () => ({
                ok: true,
                status: 200,
                data: {
                    project_ref: "proj",
                    slug: "hook",
                    active_version: "1",
                    version: "1",
                    activation_id: EXPECTED_ACTIVATION_ID,
                    verify_jwt: true,
                    background_routes: [],
                    private: "get-config-private-sentinel",
                    ...override,
                },
            }),
        });

        const response = await callback({ action: "get_config", ref: "proj", slug: "hook" });
        const payload = JSON.parse(response.content[0].text);

        expect(response.isError).toBe(true);
        expect(payload.error).toEqual({ code: "INVALID_RESPONSE", http_status: 200 });
        expect(response.content[0].text).not.toContain("sentinel");
    });

    test.each([
        ["an object", { slug: "fa-api", version: 7, activation_id: EXPECTED_ACTIVATION_ID }],
        ["a non-object entry", ["list-response-sentinel"]],
        ["a missing slug", [{ version: 7, activation_id: EXPECTED_ACTIVATION_ID, private: "list-response-sentinel" }]],
        ["an invalid slug", [{ slug: "../fa-api", version: 7, activation_id: EXPECTED_ACTIVATION_ID, private: "list-response-sentinel" }]],
        ["a string version", [{ slug: "fa-api", version: "7", activation_id: EXPECTED_ACTIVATION_ID, private: "list-response-sentinel" }]],
        ["a negative version", [{ slug: "fa-api", version: -1, activation_id: EXPECTED_ACTIVATION_ID, private: "list-response-sentinel" }]],
        ["a fractional version", [{ slug: "fa-api", version: 1.5, activation_id: EXPECTED_ACTIVATION_ID, private: "list-response-sentinel" }]],
        ["an unsafe version", [{ slug: "fa-api", version: Number.MAX_SAFE_INTEGER + 1, activation_id: EXPECTED_ACTIVATION_ID, private: "list-response-sentinel" }]],
        ["a missing activation ID", [{ slug: "fa-api", version: 7, private: "list-response-sentinel" }]],
        ["a non-canonical activation ID", [{ slug: "fa-api", version: 7, activation_id: EXPECTED_ACTIVATION_ID.toUpperCase(), private: "list-response-sentinel" }]],
        ["duplicate slugs", [
            { slug: "fa-api", version: 7, activation_id: EXPECTED_ACTIVATION_ID },
            { slug: "fa-api", version: 8, activation_id: COMMITTED_ACTIVATION_ID },
        ]],
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
                    data: [{
                        slug: "fa-api",
                        version: activeVersion,
                        activation_id: EXPECTED_ACTIVATION_ID,
                        verify_jwt: true,
                    }],
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
            "expected-activation-id": "legacy",
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

    test.each(["deploy", "deploy_bundle", "config", "activate", "delete"])(
        "rejects %s without expected-activation-id before HTTP dispatch",
        async (action) => {
            let requestCount = 0;
            const request = async () => {
                requestCount += 1;
                return { ok: true, status: 200, data: {} };
            };
            const { callback } = captureEdgeFunctionsTool({
                post: request,
                patch: request,
                delete: request,
            });
            const actionInput = {
                deploy: {
                    action,
                    ref: "proj",
                    slug: "hook",
                    code: "export default {};",
                    "expected-active-version": "1",
                },
                deploy_bundle: {
                    action,
                    ref: "proj",
                    slug: "hook",
                    files: { "index.ts": "export default {};" },
                    "expected-active-version": "1",
                },
                config: { action, ref: "proj", slug: "hook", verify_jwt: true },
                activate: {
                    action,
                    ref: "proj",
                    slug: "hook",
                    version: "2",
                    "expected-active-version": "1",
                },
                delete: { action, ref: "proj", slug: "hook" },
            }[action]!;

            await expect(callback(actionInput)).rejects.toThrow("--expected-activation-id");
            expect(requestCount).toBe(0);
        },
    );

    test.each([
        EXPECTED_ACTIVATION_ID.toUpperCase(),
        "00000000-0000-0000-0000-000000000000",
        "11111111-1111-6111-8111-111111111111",
        "not-a-uuid",
        7,
    ])("rejects invalid expected activation ID %j during argument parsing", (expectedActivationId) => {
        const { schema } = captureEdgeFunctionsTool({});

        expect(() => parseToolArguments(schema, {
            action: "activate",
            ref: "proj",
            slug: "hook",
            version: "2",
            "expected-active-version": "1",
            "expected-activation-id": expectedActivationId,
        })).toThrow("Invalid arguments");
    });

    test.each([-1, "-1", "01", "9007199254740992"])(
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

    test.each([-1, "-1", "01", "9007199254740992", true, {}])(
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
            })).rejects.toThrow("canonical non-negative safe integer");
            expect(requestCount).toBe(0);
        },
    );

    test("uploads verified prebundled bytes without minify or local bundling fields", async () => {
        const directory = mkdtempSync(join(tmpdir(), "supacloud-prebundled-cli-"));
        const bundlePath = join(directory, "fa-api.js");
        const code = "export default { fetch: () => new Response('精确字节') };\r\n";
        const expectedSha256 = createHash("sha256").update(code).digest("hex");
        writeFileSync(bundlePath, code);
        let requestBody: Record<string, unknown> | undefined;
        const { callback } = captureEdgeFunctionsTool({
            post: async (_path: string, body: Record<string, unknown>) => {
                requestBody = body;
                return {
                    ok: true,
                    status: 200,
                    data: {
                        success: true,
                        project_ref: "proj",
                        slug: "fa-api",
                        previous_active_version: "3",
                        expected_activation_id: EXPECTED_ACTIVATION_ID,
                        activation_id: COMMITTED_ACTIVATION_ID,
                        active_version: "4",
                        version: "4",
                        config: {
                            version: "4",
                            verify_jwt: true,
                            activation_id: COMMITTED_ACTIVATION_ID,
                        },
                    },
                };
            },
        });

        try {
            const response = await callback({
                action: "deploy",
                ref: "proj",
                slug: "fa-api",
                "prebundled-path": bundlePath,
                "expected-sha256": expectedSha256,
                "expected-active-version": "3",
                "expected-activation-id": EXPECTED_ACTIVATION_ID,
            });

            expect(requestBody).toEqual({
                code,
                prebundled: true,
                expected_sha256: expectedSha256,
                expected_active_version: "3",
                expected_activation_id: EXPECTED_ACTIVATION_ID,
            });
            expect(JSON.parse(response.content[0].text)).toMatchObject({
                ok: true,
                operation: "edge_functions.deploy",
                active_version: "4",
            });
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test("uploads a self-contained multi-file bundle directory without node_modules", async () => {
        const directory = mkdtempSync(join(tmpdir(), "supacloud-bundle-dir-"));
        mkdirSync(join(directory, "admin-console", "build"), { recursive: true });
        writeFileSync(join(directory, "index.ts"), "export default {};\n");
        writeFileSync(join(directory, "admin-console", "build", "index.html"), "<!doctype html>\n");
        let requestBody: Record<string, unknown> | undefined;
        const { callback } = captureEdgeFunctionsTool({
            post: async (_path: string, body: Record<string, unknown>) => {
                requestBody = body;
                return confirmedFunctionMutation("supauth");
            },
        });

        try {
            await callback({
                action: "deploy_bundle",
                ref: "proj",
                slug: "supauth",
                "bundle-dir": directory,
                entrypoint: "index.ts",
                "expected-active-version": "3",
                "expected-activation-id": EXPECTED_ACTIVATION_ID,
            });
            expect(requestBody).toMatchObject({
                files: {
                    "index.ts": "export default {};\n",
                    "admin-console/build/index.html": "<!doctype html>\n",
                },
                entrypoint: "index.ts",
            });
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test.each(["node_modules", ".git", "._metadata"])(
        "rejects forbidden bundle directory entry %s before HTTP dispatch",
        async (entryName) => {
            const directory = mkdtempSync(join(tmpdir(), "supacloud-forbidden-bundle-dir-"));
            const entryPath = join(directory, entryName);
            if (entryName.startsWith(".")) writeFileSync(entryPath, "forbidden");
            else {
                mkdirSync(entryPath);
                writeFileSync(join(entryPath, "dependency.js"), "forbidden");
            }
            let requestCount = 0;
            const { callback } = captureEdgeFunctionsTool({
                post: async () => {
                    requestCount += 1;
                    return confirmedFunctionMutation("supauth");
                },
            });

            try {
                await expect(callback({
                    action: "deploy_bundle",
                    ref: "proj",
                    slug: "supauth",
                    "bundle-dir": directory,
                    "expected-active-version": "3",
                    "expected-activation-id": EXPECTED_ACTIVATION_ID,
                })).rejects.toThrow("forbidden path");
                expect(requestCount).toBe(0);
            } finally {
                rmSync(directory, { recursive: true, force: true });
            }
        },
    );

    test("rejects symlinks in a bundle directory before HTTP dispatch", async () => {
        const directory = mkdtempSync(join(tmpdir(), "supacloud-symlink-bundle-dir-"));
        const target = join(directory, "target.ts");
        writeFileSync(target, "export default {};\n");
        symlinkSync(target, join(directory, "index.ts"));
        const { callback } = captureEdgeFunctionsTool({ post: async () => confirmedFunctionMutation("supauth") });

        try {
            await expect(callback({
                action: "deploy_bundle",
                ref: "proj",
                slug: "supauth",
                "bundle-dir": directory,
                "expected-active-version": "3",
                "expected-activation-id": EXPECTED_ACTIVATION_ID,
            })).rejects.toThrow("must not contain symlinks");
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test("rejects a prebundled file replaced after caller hashing before HTTP dispatch", async () => {
        const directory = mkdtempSync(join(tmpdir(), "supacloud-prebundled-replaced-"));
        const bundlePath = join(directory, "fa-api.js");
        const approvedCode = "export default { fetch: () => new Response('approved') };\n";
        const expectedSha256 = createHash("sha256").update(approvedCode).digest("hex");
        writeFileSync(bundlePath, "export default { fetch: () => new Response('replaced') };\n");
        let requestCount = 0;
        const { callback } = captureEdgeFunctionsTool({
            post: async () => {
                requestCount += 1;
                return { ok: true, status: 200, data: {} };
            },
        });

        try {
            await expect(callback({
                action: "deploy",
                ref: "proj",
                slug: "fa-api",
                "prebundled-path": bundlePath,
                "expected-sha256": expectedSha256,
                "expected-active-version": "absent",
                "expected-activation-id": "legacy",
            })).rejects.toThrow("SHA-256 does not match");
            expect(requestCount).toBe(0);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test("rejects invalid UTF-8 and non-regular prebundled inputs before HTTP dispatch", async () => {
        const directory = mkdtempSync(join(tmpdir(), "supacloud-prebundled-invalid-"));
        const invalidUtf8Path = join(directory, "invalid.js");
        const nestedDirectory = join(directory, "directory.js");
        const invalidUtf8 = Buffer.from([0xc3, 0x28]);
        writeFileSync(invalidUtf8Path, invalidUtf8);
        mkdirSync(nestedDirectory);
        let requestCount = 0;
        const { callback } = captureEdgeFunctionsTool({
            post: async () => {
                requestCount += 1;
                return { ok: true, status: 200, data: {} };
            },
        });

        try {
            await expect(callback({
                action: "deploy",
                ref: "proj",
                slug: "fa-api",
                "prebundled-path": invalidUtf8Path,
                "expected-sha256": createHash("sha256").update(invalidUtf8).digest("hex"),
                "expected-active-version": "absent",
                "expected-activation-id": "legacy",
            })).rejects.toThrow("valid UTF-8");
            await expect(callback({
                action: "deploy",
                ref: "proj",
                slug: "fa-api",
                "prebundled-path": nestedDirectory,
                "expected-sha256": "0".repeat(64),
                "expected-active-version": "absent",
                "expected-activation-id": "legacy",
            })).rejects.toThrow("regular file");
            expect(requestCount).toBe(0);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test.each([
        ["code and path", { code: "export default {};", path: "function.ts" }],
        ["path and prebundled path", { path: "function.ts", "prebundled-path": "bundle.js", "expected-sha256": "0".repeat(64) }],
        ["prebundled path without hash", { "prebundled-path": "bundle.js" }],
        ["hash without prebundled path", { code: "export default {};", "expected-sha256": "0".repeat(64) }],
        ["prebundled path with minify", { "prebundled-path": "bundle.js", "expected-sha256": "0".repeat(64), minify: false }],
    ])("rejects %s before HTTP dispatch", async (_label, deploymentInput) => {
        let requestCount = 0;
        const { callback } = captureEdgeFunctionsTool({
            post: async () => {
                requestCount += 1;
                return { ok: true, status: 200, data: {} };
            },
        });

        await expect(callback({
            action: "deploy",
            ref: "proj",
            slug: "fa-api",
            "expected-active-version": "absent",
            "expected-activation-id": "legacy",
            ...deploymentInput,
        })).rejects.toThrow();
        expect(requestCount).toBe(0);
    });

    test.each([0, "0"])(
        "deploys over legacy active version %j with a confirmed CAS receipt",
        async (expectedActiveVersion) => {
            const calls: Array<{ path: string; body: unknown }> = [];
            const { callback, schema } = captureEdgeFunctionsTool({
                post: async (path: string, body: unknown) => {
                    calls.push({ path, body });
                    return {
                        ok: true,
                        status: 200,
                        data: {
                            success: true,
                            project_ref: "proj",
                            slug: "legacy-hook",
                            previous_active_version: "0",
                            expected_activation_id: "legacy",
                            activation_id: COMMITTED_ACTIVATION_ID,
                            active_version: "1",
                            version: "1",
                            config: {
                                version: "1",
                                verify_jwt: true,
                                activation_id: COMMITTED_ACTIVATION_ID,
                            },
                        },
                    };
                },
            });
            const args = parseToolArguments(schema, {
                action: "deploy_bundle",
                ref: "proj",
                slug: "legacy-hook",
                files: { "index.ts": "export default {}" },
                "expected-active-version": expectedActiveVersion,
                "expected-activation-id": "legacy",
            });

            const response = await callback(args);

            expect(calls).toEqual([{
                path: "/v1/projects/proj/functions/legacy-hook/bundle",
                body: {
                    files: { "index.ts": "export default {}" },
                    entrypoint: undefined,
                    minify: undefined,
                    expected_active_version: "0",
                    expected_activation_id: "legacy",
                },
            }]);
            expect(JSON.parse(response.content[0].text)).toMatchObject({
                ok: true,
                previous_active_version: "0",
                active_version: "1",
            });
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
                        expected_activation_id: "legacy",
                        activation_id: COMMITTED_ACTIVATION_ID,
                        active_version: "1",
                        version: "1",
                        config: {
                            version: "1",
                            verify_jwt: true,
                            background_routes: ["/work/*"],
                            activation_id: COMMITTED_ACTIVATION_ID,
                        },
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
            "expected-activation-id": "legacy",
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
                    expected_activation_id: "legacy",
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
                        expected_activation_id: EXPECTED_ACTIVATION_ID,
                        activation_id: COMMITTED_ACTIVATION_ID,
                        active_version: "4",
                        version: "4",
                        config: {
                            version: "4",
                            verify_jwt: false,
                            activation_id: COMMITTED_ACTIVATION_ID,
                        },
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
            "expected-activation-id": EXPECTED_ACTIVATION_ID,
        });

        expect(calls).toEqual([{
            method: "post",
            path: "/v1/projects/proj/functions/public-hook",
            body: {
                code: "export default { fetch: () => new Response('ok') }",
                minify: undefined,
                expected_active_version: "3",
                expected_activation_id: EXPECTED_ACTIVATION_ID,
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
            "expected-activation-id": EXPECTED_ACTIVATION_ID,
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
            "expected-activation-id": EXPECTED_ACTIVATION_ID,
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
                    expected_activation_id: "legacy",
                    activation_id: COMMITTED_ACTIVATION_ID,
                    active_version: "0",
                    version: "0",
                    config: {
                        version: "0",
                        verify_jwt: true,
                        activation_id: COMMITTED_ACTIVATION_ID,
                    },
                },
            }),
        });

        const response = await callback({
            action: "deploy_bundle",
            ref: "proj",
            slug: "public-hook",
            files: { "index.ts": "export default {}" },
            "expected-active-version": "absent",
            "expected-activation-id": "legacy",
        });

        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).error).toEqual({
            code: "OUTCOME_UNKNOWN",
            http_status: 200,
        });
    });

    test.each([
        ["a missing expected activation ID", {
            success: true,
            project_ref: "proj",
            slug: "public-hook",
            previous_active_version: "1",
            activation_id: COMMITTED_ACTIVATION_ID,
            active_version: "2",
            version: "2",
            config: { version: "2", verify_jwt: true, activation_id: COMMITTED_ACTIVATION_ID },
        }],
        ["a mismatched expected activation ID", {
            success: true,
            project_ref: "proj",
            slug: "public-hook",
            previous_active_version: "1",
            expected_activation_id: "legacy",
            activation_id: COMMITTED_ACTIVATION_ID,
            active_version: "2",
            version: "2",
            config: { version: "2", verify_jwt: true, activation_id: COMMITTED_ACTIVATION_ID },
        }],
        ["a legacy committed activation ID", {
            success: true,
            project_ref: "proj",
            slug: "public-hook",
            previous_active_version: "1",
            expected_activation_id: EXPECTED_ACTIVATION_ID,
            activation_id: "legacy",
            active_version: "2",
            version: "2",
            config: { version: "2", verify_jwt: true, activation_id: "legacy" },
        }],
        ["a mismatched config activation ID", {
            success: true,
            project_ref: "proj",
            slug: "public-hook",
            previous_active_version: "1",
            expected_activation_id: EXPECTED_ACTIVATION_ID,
            activation_id: COMMITTED_ACTIVATION_ID,
            active_version: "2",
            version: "2",
            config: { version: "2", verify_jwt: true, activation_id: EXPECTED_ACTIVATION_ID },
        }],
    ])("rejects a successful mutation receipt containing %s", async (_label, data) => {
        const { callback } = captureEdgeFunctionsTool({
            post: async () => ({ ok: true, status: 200, data }),
        });

        const response = await callback({
            action: "deploy_bundle",
            ref: "proj",
            slug: "public-hook",
            files: { "index.ts": "export default {}" },
            "expected-active-version": "1",
            "expected-activation-id": EXPECTED_ACTIVATION_ID,
        });

        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).error).toEqual({
            code: "OUTCOME_UNKNOWN",
            http_status: 200,
        });
    });

    test("sends and binds the expected activation ID when deleting a Function", async () => {
        const calls: Array<{ path: string; body: unknown }> = [];
        const { callback } = captureEdgeFunctionsTool({
            delete: async (path: string, body: unknown) => {
                calls.push({ path, body });
                return {
                    ok: true,
                    status: 200,
                    data: {
                        success: true,
                        project_ref: "proj",
                        slug: "public-hook",
                        expected_activation_id: EXPECTED_ACTIVATION_ID,
                        activation_id: COMMITTED_ACTIVATION_ID,
                        previous_active_version: "4",
                        active_version: "absent",
                        config: {
                            verify_jwt: true,
                            activation_id: COMMITTED_ACTIVATION_ID,
                        },
                    },
                };
            },
        });

        const response = await callback({
            action: "delete",
            ref: "proj",
            slug: "public-hook",
            "expected-activation-id": EXPECTED_ACTIVATION_ID,
        });

        expect(calls).toEqual([{
            path: "/v1/projects/proj/functions/public-hook",
            body: { expected_activation_id: EXPECTED_ACTIVATION_ID },
        }]);
        expect(response.isError).toBeUndefined();
        expect(JSON.parse(response.content[0].text)).toMatchObject({
            ok: true,
            operation: "edge_functions.delete",
            activation_id: COMMITTED_ACTIVATION_ID,
            active_version: "absent",
        });
    });

    test.each(["config", "delete"])(
        "fails %s closed when the bounded mutation response cannot prove the outcome",
        async (action) => {
            const responseSentinel = `${action}-private-response-sentinel`;
            const mutationFailure = {
                ok: false,
                status: 200,
                data: { error: responseSentinel },
                responseReadError: true,
            };
            const { callback } = captureEdgeFunctionsTool({
                patchReleaseMutation: async () => mutationFailure,
                deleteReleaseMutation: async () => mutationFailure,
            });
            const args = action === "config"
                ? {
                    action,
                    ref: "proj",
                    slug: "hook",
                    verify_jwt: false,
                    "expected-activation-id": EXPECTED_ACTIVATION_ID,
                }
                : {
                    action,
                    ref: "proj",
                    slug: "hook",
                    "expected-activation-id": EXPECTED_ACTIVATION_ID,
                };

            const response = await callback(args);
            const payload = JSON.parse(response.content[0].text);

            expect(response.isError).toBe(true);
            expect(payload.error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 200 });
            expect(response.content[0].text).not.toContain(responseSentinel);
        },
    );

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

    test("routes every release-control Function mutation through the bounded response transport", async () => {
        const releaseMutationPaths: string[] = [];
        let ordinaryPostCount = 0;
        const { callback } = captureEdgeFunctionsTool({
            post: async () => {
                ordinaryPostCount += 1;
                throw new Error("release mutation used the ordinary POST reader");
            },
            postReleaseMutation: async (path: string, body: Record<string, unknown>) => {
                releaseMutationPaths.push(path);
                const slug = path.split("/functions/")[1].split("/")[0];
                const previousActiveVersion = String(body.expected_active_version);
                const expectedActivationId = String(body.expected_activation_id);
                const activeVersion = { single: "2", bundle: "3", restore: "1" }[slug];
                return {
                    ok: true,
                    status: 200,
                    data: {
                        success: true,
                        project_ref: "proj",
                        slug,
                        previous_active_version: previousActiveVersion,
                        expected_activation_id: expectedActivationId,
                        activation_id: COMMITTED_ACTIVATION_ID,
                        active_version: activeVersion,
                        version: activeVersion,
                        config: {
                            version: activeVersion,
                            verify_jwt: true,
                            activation_id: COMMITTED_ACTIVATION_ID,
                        },
                    },
                };
            },
        });

        const mutations = [
            {
                action: "deploy",
                ref: "proj",
                slug: "single",
                code: "export default {};",
                "expected-active-version": "1",
                "expected-activation-id": EXPECTED_ACTIVATION_ID,
            },
            {
                action: "deploy_bundle",
                ref: "proj",
                slug: "bundle",
                files: { "index.ts": "export default {};" },
                "expected-active-version": "2",
                "expected-activation-id": EXPECTED_ACTIVATION_ID,
            },
            {
                action: "activate",
                ref: "proj",
                slug: "restore",
                version: "1",
                "expected-active-version": "3",
                "expected-activation-id": EXPECTED_ACTIVATION_ID,
            },
        ];
        const responses = [];
        for (const mutation of mutations) responses.push(await callback(mutation));

        expect(responses.every((response) => response.isError !== true)).toBe(true);
        expect(ordinaryPostCount).toBe(0);
        expect(releaseMutationPaths).toEqual([
            "/v1/projects/proj/functions/single",
            "/v1/projects/proj/functions/bundle/bundle",
            "/v1/projects/proj/functions/restore/versions/1/activate",
        ]);
    });

    test.each([
        ["HTTP 503 after possible commit", { ok: false, status: 503, data: { error: "private-server-detail" } }, "OUTCOME_UNKNOWN", 503],
        ["HTTP 408 after possible commit", { ok: false, status: 408, data: { error: "private-server-detail" } }, "OUTCOME_UNKNOWN", 408],
        ["explicit HTTP rejection", { ok: false, status: 409, data: { error: "private-server-detail" } }, "HTTP_ERROR", 409],
        ["response read failure after HTTP 409", {
            ok: false,
            status: 409,
            data: { error: "private-server-detail" },
            responseReadError: true,
        }, "OUTCOME_UNKNOWN", 409],
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
            "expected-activation-id": EXPECTED_ACTIVATION_ID,
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
            "expected-activation-id": EXPECTED_ACTIVATION_ID,
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
