import { describe, expect, test } from "bun:test";
import type { ToolSchema } from "../schema";
import { registerOAuthClientTools } from "./oauth-client-tools";

const PROJECT_REF = "central-supauth";
const CLIENT_ID = "release-canary.client-1";
const HTTPS_CALLBACK = "https://release-canary.example.test/callback";

type ToolResult = {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
};

type OAuthClientsCallback = (args: Record<string, unknown>) => Promise<ToolResult>;

function releaseCanaryClient(overrides: Record<string, unknown> = {}) {
    return {
        client_id: CLIENT_ID,
        client_name: "supacloud-release-canary",
        client_type: "public",
        token_endpoint_auth_method: "none",
        redirect_uris: [HTTPS_CALLBACK],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        ...overrides,
    };
}

function captureOAuthClientsTool(http: Record<string, unknown>): { schema: ToolSchema; callback: OAuthClientsCallback } {
    let schema: ToolSchema | undefined;
    let callback: OAuthClientsCallback | undefined;
    registerOAuthClientTools({
        tool(name, _description, toolSchema, toolCallback) {
            if (name !== "oauth_clients") return;
            schema = toolSchema;
            callback = toolCallback;
        },
    }, http as never);
    if (!schema || !callback) throw new Error("oauth_clients tool was not registered");
    return { schema, callback };
}

function payload(response: ToolResult): Record<string, unknown> {
    return JSON.parse(response.content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("release-canary OAuth client CLI control", () => {
    test("lists a strict public projection without exposing upstream-only fields", async () => {
        const calls: Array<{ path: string; options: unknown }> = [];
        const responseSecret = "client-secret-value-must-not-leak";
        const { callback } = captureOAuthClientsTool({
            get: async (path: string, options: unknown) => {
                calls.push({ path, options });
                return {
                    ok: true,
                    status: 200,
                    data: { clients: [releaseCanaryClient({ client_secret: responseSecret, created_at: "private" })] },
                };
            },
        });

        const response = await callback({ action: "list", ref: PROJECT_REF });

        expect(calls).toEqual([{
            path: `/v1/projects/${PROJECT_REF}/auth/oauth-clients`,
            options: { maxJsonBytes: 256 * 1024, responseTimeoutMs: 5_000 },
        }]);
        expect(payload(response)).toEqual({
            schema: "supacloud.cli.release-control.v1",
            ok: true,
            operation: "oauth_clients.list",
            project_ref: PROJECT_REF,
            clients: [releaseCanaryClient()],
        });
        expect(response.content[0]?.text).not.toContain(responseSecret);
        expect(response.content[0]?.text).not.toContain("private");
    });

    test.each([
        { grant_types: ["authorization_code", "refresh_token"] },
        { response_types: ["code", "token"] },
    ])("fails closed when a named client in the list does not satisfy the immutable contract", async (overrides) => {
        const { callback } = captureOAuthClientsTool({
            get: async () => ({
                ok: true,
                status: 200,
                data: { clients: [releaseCanaryClient(overrides)] },
            }),
        });

        const response = await callback({ action: "list", ref: PROJECT_REF });

        expect(response.isError).toBe(true);
        expect(payload(response)).toMatchObject({
            ok: false,
            operation: "oauth_clients.list",
            error: { code: "INVALID_RESPONSE", http_status: 200 },
        });
    });

    test.each([200, 201])("creates from a %i GoTrue client-id receipt and requires an exact post-read", async (status) => {
        const requests: Array<{ method: string; path: string; body?: unknown }> = [];
        let reads = 0;
        const { callback } = captureOAuthClientsTool({
            get: async (path: string) => {
                requests.push({ method: "get", path });
                reads += 1;
                return reads === 1
                    ? { ok: true, status: 200, data: { clients: [] } }
                    : { ok: true, status: 200, data: releaseCanaryClient() };
            },
            postReleaseMutation: async (path: string, body: unknown) => {
                requests.push({ method: "post", path, body });
                return { ok: true, status, data: { client_id: CLIENT_ID } };
            },
        });

        const response = await callback({ action: "create", ref: PROJECT_REF, redirect_uri: HTTPS_CALLBACK });

        expect(requests).toEqual([
            { method: "get", path: `/v1/projects/${PROJECT_REF}/auth/oauth-clients` },
            {
                method: "post",
                path: `/v1/projects/${PROJECT_REF}/auth/oauth-clients`,
                body: {
                    client_type: "public",
                    token_endpoint_auth_method: "none",
                    redirect_uris: [HTTPS_CALLBACK],
                    grant_types: ["authorization_code"],
                    client_name: "supacloud-release-canary",
                },
            },
            { method: "get", path: `/v1/projects/${PROJECT_REF}/auth/oauth-clients/${CLIENT_ID}` },
        ]);
        expect(payload(response)).toMatchObject({
            ok: true,
            operation: "oauth_clients.create",
            project_ref: PROJECT_REF,
            client: releaseCanaryClient(),
            reused: false,
        });
    });

    test("reuses only the exact already-registered immutable client", async () => {
        let mutationCount = 0;
        const { callback } = captureOAuthClientsTool({
            get: async () => ({ ok: true, status: 200, data: { clients: [releaseCanaryClient()] } }),
            postReleaseMutation: async () => {
                mutationCount += 1;
                return { ok: true, status: 200, data: { client_id: CLIENT_ID } };
            },
        });

        const response = await callback({ action: "create", ref: PROJECT_REF, redirect_uri: HTTPS_CALLBACK });

        expect(mutationCount).toBe(0);
        expect(payload(response)).toMatchObject({
            ok: true,
            operation: "oauth_clients.create",
            reused: true,
        });
    });

    test("never mutates when a named client has a different callback", async () => {
        let mutationCount = 0;
        const { callback } = captureOAuthClientsTool({
            get: async () => ({
                ok: true,
                status: 200,
                data: { clients: [releaseCanaryClient({ redirect_uris: ["https://other.example.test/callback"] })] },
            }),
            postReleaseMutation: async () => {
                mutationCount += 1;
                return { ok: true, status: 200, data: {} };
            },
        });

        const response = await callback({ action: "create", ref: PROJECT_REF, redirect_uri: HTTPS_CALLBACK });

        expect(mutationCount).toBe(0);
        expect(response.isError).toBe(true);
        expect(payload(response)).toMatchObject({
            error: { code: "MUTATION_NOT_SUCCEEDED", http_status: null },
        });
    });

    test("reports an unknown outcome when create read-back is not exact", async () => {
        let reads = 0;
        const { callback } = captureOAuthClientsTool({
            get: async () => {
                reads += 1;
                return reads === 1
                    ? { ok: true, status: 200, data: { clients: [] } }
                    : { ok: true, status: 200, data: releaseCanaryClient({ grant_types: ["refresh_token"] }) };
            },
            postReleaseMutation: async () => ({ ok: true, status: 200, data: { client_id: CLIENT_ID } }),
        });

        const response = await callback({ action: "create", ref: PROJECT_REF, redirect_uri: HTTPS_CALLBACK });

        expect(response.isError).toBe(true);
        expect(payload(response)).toMatchObject({
            ok: false,
            operation: "oauth_clients.create",
            error: { code: "OUTCOME_UNKNOWN", http_status: 200 },
        });
    });

    test.each([
        "http://release-canary.example.test/callback",
        "http://127.0.0.1/callback",
        "https://release-canary.example.test/callback?code=unsafe",
        "https://user:password@release-canary.example.test/callback",
    ])("rejects unsafe redirect %s before a mutation", async (redirectUri) => {
        let requestCount = 0;
        const { callback } = captureOAuthClientsTool({
            get: async () => {
                requestCount += 1;
                return { ok: true, status: 200, data: { clients: [] } };
            },
            postReleaseMutation: async () => {
                requestCount += 1;
                return { ok: true, status: 200, data: {} };
            },
        });

        await expect(callback({ action: "create", ref: PROJECT_REF, redirect_uri: redirectUri })).rejects.toThrow("redirect_uri");
        expect(requestCount).toBe(0);
    });

    test("accepts a strict HTTPS callback and a port-bound loopback callback", async () => {
        const requests: unknown[] = [];
        const { callback } = captureOAuthClientsTool({
            get: async () => ({ ok: true, status: 200, data: { clients: [] } }),
            postReleaseMutation: async (_path: string, body: unknown) => {
                requests.push(body);
                return { ok: true, status: 200, data: { client_id: CLIENT_ID } };
            },
        });
        let postRead = false;
        const postReadTool = captureOAuthClientsTool({
            get: async () => {
                if (postRead) return { ok: true, status: 200, data: releaseCanaryClient({ redirect_uris: ["http://127.0.0.1:43859/callback"] }) };
                postRead = true;
                return { ok: true, status: 200, data: { clients: [] } };
            },
            postReleaseMutation: async (_path: string, body: unknown) => {
                requests.push(body);
                return { ok: true, status: 200, data: { client_id: CLIENT_ID } };
            },
        });

        await callback({ action: "create", ref: PROJECT_REF, redirect_uri: HTTPS_CALLBACK });
        const loopbackResponse = await postReadTool.callback({
            action: "create", ref: PROJECT_REF, redirect_uri: "http://127.0.0.1:43859/callback",
        });

        expect(payload(loopbackResponse)).toMatchObject({ ok: true, reused: false });
        expect(requests).toEqual([
            expect.objectContaining({ redirect_uris: [HTTPS_CALLBACK] }),
            expect.objectContaining({ redirect_uris: ["http://127.0.0.1:43859/callback"] }),
        ]);
    });

    test("deletes only after matching the exact client and callback, then proving absence", async () => {
        const requests: Array<{ method: string; path: string }> = [];
        const { callback } = captureOAuthClientsTool({
            get: async (path: string) => {
                requests.push({ method: "get", path });
                return path.endsWith(`/${CLIENT_ID}`)
                    ? { ok: true, status: 200, data: releaseCanaryClient() }
                    : { ok: true, status: 200, data: { clients: [] } };
            },
            deleteReleaseMutation: async (path: string) => {
                requests.push({ method: "delete", path });
                return { ok: true, status: 204, data: null };
            },
        });

        const response = await callback({
            action: "delete", ref: PROJECT_REF, client_id: CLIENT_ID, redirect_uri: HTTPS_CALLBACK,
        });

        expect(requests).toEqual([
            { method: "get", path: `/v1/projects/${PROJECT_REF}/auth/oauth-clients/${CLIENT_ID}` },
            { method: "delete", path: `/v1/projects/${PROJECT_REF}/auth/oauth-clients/${CLIENT_ID}` },
            { method: "get", path: `/v1/projects/${PROJECT_REF}/auth/oauth-clients` },
        ]);
        expect(payload(response)).toMatchObject({
            ok: true,
            operation: "oauth_clients.delete",
            project_ref: PROJECT_REF,
            client_id: CLIENT_ID,
            deleted: true,
        });
    });

    test.each([
        ["transport failure", { ok: false, status: 500, data: {}, transportError: true }],
        ["unreadable response", { ok: false, status: 200, data: {}, responseReadError: true }],
        ["server failure", { ok: false, status: 503, data: {} }],
        ["still-present client", { ok: true, status: 200, data: { clients: [releaseCanaryClient()] } }],
    ] as const)("reports an unknown deletion outcome after %s", async (_label, postRead) => {
        const { callback } = captureOAuthClientsTool({
            get: async (path: string) => path.endsWith(`/${CLIENT_ID}`)
                ? { ok: true, status: 200, data: releaseCanaryClient() }
                : postRead,
            deleteReleaseMutation: async () => ({ ok: true, status: 204, data: null }),
        });

        const response = await callback({
            action: "delete", ref: PROJECT_REF, client_id: CLIENT_ID, redirect_uri: HTTPS_CALLBACK,
        });

        expect(response.isError).toBe(true);
        expect(payload(response)).toMatchObject({
            ok: false,
            operation: "oauth_clients.delete",
            error: { code: "OUTCOME_UNKNOWN", http_status: 204 },
        });
    });
});
