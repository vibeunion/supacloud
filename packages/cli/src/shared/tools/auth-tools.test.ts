import { describe, expect, test } from "bun:test";
import { parseToolArguments, type ToolSchema } from "../schema";
import { registerAuthTools } from "./auth-tools";

type AuthToolCallback = (
    args: Record<string, unknown>,
) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

function captureAuthTool(http: Record<string, unknown>) {
    let schema: ToolSchema | undefined;
    let callback: AuthToolCallback | undefined;
    registerAuthTools({
        tool(name: string, _description: string, toolSchema: ToolSchema, toolCallback: AuthToolCallback) {
            if (name !== "auth") return;
            schema = toolSchema;
            callback = toolCallback;
        },
    }, http as any);

    if (!schema || !callback) throw new Error("auth tool was not registered");
    return { schema, callback };
}

describe("auth CLI mutation contract", () => {
    test("decodes a CLI JSON config before sending the PATCH request", async () => {
        const requests: Array<{ path: string; body: unknown }> = [];
        const { schema, callback } = captureAuthTool({
            patch: async (path: string, body: unknown) => {
                requests.push({ path, body });
                return { ok: true, status: 200, data: {} };
            },
        });
        const parsed = parseToolArguments(schema, {
            action: "update_config",
            ref: "project-a",
            config: '{"jwt_expiry":5400}',
        });

        const response = await callback(parsed);

        expect(requests).toEqual([{
            path: "/v1/projects/project-a/config/auth",
            body: { jwt_expiry: 5400 },
        }]);
        expect(response.isError).toBeUndefined();
        expect(response.content[0].text).toBe("✅ Auth config updated");
    });

    test.each([
        ["update_settings", "/v1/projects/project-a/auth/config"],
        ["update_config", "/v1/projects/project-a/config/auth"],
    ])("returns a machine-readable persisted failure for %s", async (action, expectedPath) => {
        const responseSecret = "must-not-be-printed";
        const requests: string[] = [];
        const { callback } = captureAuthTool({
            patch: async (path: string) => {
                requests.push(path);
                return {
                    ok: false,
                    status: 503,
                    data: {
                        code: "AUTH_RUNTIME_APPLY_FAILED",
                        message: `runtime rejected ${responseSecret}`,
                        persisted: true,
                        runtime_applied: false,
                        runtime_mode: "local",
                        request_body: { secret: responseSecret },
                    },
                };
            },
        });

        const response = await callback({ action, ref: "project-a", config: { enabled: true } });
        const failure = JSON.parse(response.content[0].text);

        expect(requests).toEqual([expectedPath]);
        expect(response.isError).toBe(true);
        expect(failure).toEqual({
            ok: false,
            http_status: 503,
            code: "AUTH_RUNTIME_APPLY_FAILED",
            persisted: true,
            runtime_applied: false,
            runtime_mode: "local",
        });
        expect(response.content[0].text).not.toContain(responseSecret);
        expect(response.content[0].text).not.toContain("request_body");
    });

    test("fails closed with only the HTTP status for an unrecognized error body", async () => {
        const secretShapedCode = "TOKEN_SECRET_MUST_NOT_PRINT_123";
        const { callback } = captureAuthTool({
            patch: async () => ({
                ok: false,
                status: 400,
                data: { code: secretShapedCode, message: "sensitive diagnostic" },
            }),
        });

        const response = await callback({
            action: "update_config",
            ref: "project-a",
            config: { enabled: true },
        });

        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text)).toEqual({ ok: false, http_status: 400 });
        expect(response.content[0].text).not.toContain(secretShapedCode);
        expect(response.content[0].text).not.toContain("sensitive diagnostic");
    });

    test("preserves the shared Auth runtime mode from a safe failure response", async () => {
        const { callback } = captureAuthTool({
            patch: async () => ({
                ok: false,
                status: 503,
                data: { persisted: true, runtime_mode: "shared" },
            }),
        });

        const response = await callback({
            action: "update_settings",
            ref: "project-a",
            config: { enabled: true },
        });

        expect(JSON.parse(response.content[0].text)).toEqual({
            ok: false,
            http_status: 503,
            persisted: true,
            runtime_mode: "shared",
        });
    });

    test("preserves only safe owner dependent-refresh state", async () => {
        const { callback } = captureAuthTool({
            patch: async () => ({
                ok: false,
                status: 503,
                data: {
                    code: "SUPAUTH_DEPENDENT_REFRESH_FAILED",
                    persisted: true,
                    runtime_applied: true,
                    dependents_applied: false,
                    dependent_status: "failed",
                    runtime_mode: "owner",
                    failed_dependents: ["customer-sensitive-ref"],
                },
            }),
        });

        const response = await callback({
            action: "update_config",
            ref: "project-a",
            config: { enabled: true },
        });

        expect(JSON.parse(response.content[0].text)).toEqual({
            ok: false,
            http_status: 503,
            code: "SUPAUTH_DEPENDENT_REFRESH_FAILED",
            persisted: true,
            runtime_applied: true,
            dependents_applied: false,
            dependent_status: "failed",
            runtime_mode: "owner",
        });
        expect(response.content[0].text).not.toContain("customer-sensitive-ref");
    });
});
