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
    test("lists bounded users with pagination and projects safe fields", async () => {
        const requests: Array<{ path: string; options: unknown }> = [];
        const { schema, callback } = captureAuthTool({
            get: async (path: string, options: unknown) => {
                requests.push({ path, options });
                return {
                    ok: true,
                    status: 200,
                    data: {
                        users: [{
                            id: "00000000-0000-4000-8000-000000000001",
                            email: "operator@example.test",
                            encrypted_password: "must-not-return",
                            confirmation_token: "must-not-return",
                        }],
                        total: 1,
                        page: 2,
                        per_page: 1,
                    },
                };
            },
        });

        const args = parseToolArguments(schema, {
            action: "list_users",
            ref: "project-a",
            page: 2,
            per_page: 1,
            search: "operator@example.test",
        });
        const response = await callback(args);
        const output = JSON.parse(response.content[0].text);

        expect(requests[0]?.path).toBe("/v1/projects/project-a/auth/users?page=2&per_page=1&search=operator%40example.test");
        expect(requests[0]?.options).toEqual({ maxJsonBytes: 64 * 1024, responseTimeoutMs: 5_000 });
        expect(output.users).toEqual([{ id: "00000000-0000-4000-8000-000000000001", email: "operator@example.test" }]);
        expect(response.content[0].text).not.toContain("must-not-return");
    });

    test("gets an exact UUID user and rejects path injection", async () => {
        const paths: string[] = [];
        const { callback } = captureAuthTool({
            get: async (path: string) => {
                paths.push(path);
                return { ok: true, status: 200, data: { id: "00000000-0000-4000-8000-000000000002", email: "user@example.test" } };
            },
        });

        const response = await callback({
            action: "get_user",
            ref: "project-a",
            user_id: "00000000-0000-4000-8000-000000000002",
        });
        expect(paths).toEqual(["/v1/projects/project-a/auth/users/00000000-0000-4000-8000-000000000002"]);
        expect(JSON.parse(response.content[0].text).user.email).toBe("user@example.test");
        await expect(callback({ action: "get_user", ref: "project-a", user_id: "../../secrets" })).rejects.toThrow("must be a UUID");
    });

    test("returns only the action link from a successful bounded generate_link response", async () => {
        const requests: Array<{ path: string; body: unknown }> = [];
        const { callback } = captureAuthTool({
            postReleaseMutation: async (path: string, body: unknown) => {
                requests.push({ path, body });
                return {
                    ok: true,
                    status: 200,
                    data: {
                        properties: {
                            action_link: "https://auth.example.test/verify?token=one-time",
                            hashed_token: "must-not-return",
                        },
                        user: { email: "user@example.test" },
                    },
                };
            },
        });

        const response = await callback({
            action: "generate_link",
            ref: "project-a",
            type: "magiclink",
            email: "user@example.test",
            redirect_to: "https://app.example.test/callback",
        });
        expect(requests).toEqual([{
            path: "/v1/projects/project-a/auth/generate_link",
            body: { type: "magiclink", email: "user@example.test", redirect_to: "https://app.example.test/callback" },
        }]);
        expect(JSON.parse(response.content[0].text)).toEqual({
            ok: true,
            operation: "auth.generate_link",
            action_link: "https://auth.example.test/verify?token=one-time",
        });
        expect(response.content[0].text).not.toContain("must-not-return");
    });

    test("does not echo sensitive upstream bodies from generate_link failures", async () => {
        const secret = "action-link-secret";
        const { callback } = captureAuthTool({
            postReleaseMutation: async () => ({
                ok: false,
                status: 502,
                data: { action_link: secret, email: "user@example.test", token: secret },
            }),
        });
        const response = await callback({ action: "generate_link", ref: "project-a", type: "magiclink", email: "user@example.test" });
        expect(response.isError).toBe(true);
        expect(response.content[0].text).not.toContain(secret);
        expect(response.content[0].text).not.toContain("user@example.test");
    });

    test("rejects malformed or cross-user auth projections without reflecting remote fields", async () => {
        const secret = "nested-private-auth-field";
        const wrongUser = captureAuthTool({
            get: async () => ({
                ok: true,
                status: 200,
                data: {
                    id: "00000000-0000-4000-8000-000000000099",
                    email: "other@example.test",
                },
            }),
        });
        const wrongResponse = await wrongUser.callback({
            action: "get_user",
            ref: "project-a",
            user_id: "00000000-0000-4000-8000-000000000002",
        });
        expect(wrongResponse.isError).toBe(true);
        expect(JSON.parse(wrongResponse.content[0].text).error).toBe("INVALID_RESPONSE");

        const malformedList = captureAuthTool({
            get: async () => ({
                ok: true,
                status: 200,
                data: {
                    users: [{
                        id: "00000000-0000-4000-8000-000000000001",
                        email: { token: secret },
                    }],
                    total: 1,
                    page: 1,
                    per_page: 50,
                },
            }),
        });
        const malformedResponse = await malformedList.callback({ action: "list_users", ref: "project-a" });
        expect(malformedResponse.isError).toBe(true);
        expect(malformedResponse.content[0].text).not.toContain(secret);
    });

    test("preserves empty optional email and phone fields from GoTrue", async () => {
    const userId = "00000000-0000-4000-8000-000000000002";
    const { callback } = captureAuthTool({
        get: async () => ({
            ok: true,
            status: 200,
            data: {
                id: userId,
                email: "",
                phone: "",
                created_at: "2026-08-18T00:00:00.000Z",
                last_sign_in_at: null,
            },
        }),
    });

    const response = await callback({ action: "get_user", ref: "project-a", user_id: userId });

    expect(response.isError).not.toBe(true);
    expect(JSON.parse(response.content[0].text).user).toEqual({
        id: userId,
        email: "",
        phone: "",
        created_at: "2026-08-18T00:00:00.000Z",
        last_sign_in_at: null,
    });
});

    test("bounds auth search and email inputs before HTTP", async () => {
        let requestCount = 0;
        const { callback } = captureAuthTool({
            get: async () => {
                requestCount += 1;
                return { ok: true, status: 200, data: { users: [] } };
            },
            postReleaseMutation: async () => {
                requestCount += 1;
                return { ok: true, status: 200, data: {} };
            },
        });

        await expect(callback({
            action: "list_users",
            ref: "project-a",
            search: "x".repeat(257),
        })).rejects.toThrow("exceeds 256 characters");
        await expect(callback({
            action: "generate_link",
            ref: "project-a",
            type: "magiclink",
            email: "x".repeat(321),
        })).rejects.toThrow("exceeds 320 characters");
        expect(requestCount).toBe(0);
    });

    test("supports explicit localhost callbacks and rejects unsafe link types", async () => {
        const requests: Array<{ path: string; body: unknown }> = [];
        const { callback } = captureAuthTool({
            postReleaseMutation: async (path: string, body: unknown) => {
                requests.push({ path, body });
                return {
                    ok: true,
                    status: 200,
                    data: { action_link: "http://project-a.api.127.0.0.1.sslip.io/auth/v1/verify?token=safe" },
                };
            },
        });
        await callback({
            action: "generate_link",
            ref: "project-a",
            type: "recovery",
            email: "user@example.test",
            redirect_to: "http://localhost:3000/callback",
        });
        expect(requests[0]?.body).toEqual({
            type: "recovery",
            email: "user@example.test",
            redirect_to: "http://localhost:3000/callback",
        });
        await expect(callback({
            action: "generate_link",
            ref: "project-a",
            type: "signup",
            email: "user@example.test",
        })).rejects.toThrow("magiclink, recovery, or invite");
        expect(requests).toHaveLength(1);
    });

    test("rejects malformed action links and reports an uncertain mutation without reflection", async () => {
        const secret = "private-generated-action-link";
        for (const result of [
            {
                ok: true,
                status: 200,
                data: { action_link: `javascript:${secret}` },
            },
            {
                ok: false,
                status: 503,
                data: { action_link: secret, email: "user@example.test" },
            },
            {
                ok: false,
                status: 500,
                data: { error: "Network Error" },
                transportError: true,
            },
        ]) {
            const { callback } = captureAuthTool({ postReleaseMutation: async () => result });
            const response = await callback({
                action: "generate_link",
                ref: "project-a",
                type: "magiclink",
                email: "user@example.test",
            });
            expect(response.isError).toBe(true);
            expect(JSON.parse(response.content[0].text)).toEqual({
                ok: false,
                operation: "auth.generate_link",
                error: {
                    code: "OUTCOME_UNKNOWN",
                    http_status: result.transportError ? null : result.status,
                },
            });
            expect(response.content[0].text).not.toContain(secret);
            expect(response.content[0].text).not.toContain("user@example.test");
        }
    });

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
