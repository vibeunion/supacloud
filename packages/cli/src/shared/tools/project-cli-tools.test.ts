import { describe, expect, test } from "bun:test";
import { schemaEnumValues, type ToolSchema } from "../schema";
import { registerAdminProjectCliTools, registerUserProjectCliTools } from "./project-cli-tools";

type ProjectToolResult = {
    content: Array<{ text: string }>;
    isError?: boolean;
};

function captureProjectTool(http: Record<string, unknown>, projectRef = "proj") {
    let callback: ((args: Record<string, unknown>) => Promise<ProjectToolResult>) | undefined;
    registerUserProjectCliTools({
        tool(name: string, _description: string, _schema: Record<string, unknown>, toolCallback: typeof callback) {
            if (name !== "project") return;
            callback = toolCallback;
        },
    }, http as any, { projectRef });

    if (!callback) throw new Error("project tool was not registered");
    return callback;
}

function captureAdminProjectTool(http: Record<string, unknown>) {
    let callback: ((args: Record<string, unknown>) => Promise<ProjectToolResult>) | undefined;
    registerAdminProjectCliTools({
        tool(name: string, _description: string, _schema: Record<string, unknown>, toolCallback: typeof callback) {
            if (name === "project") callback = toolCallback;
        },
    }, http as any);

    if (!callback) throw new Error("admin project tool was not registered");
    return callback;
}

const PROJECT_REF = "abcdefghijklmnopqrst";
const PROJECT_SUMMARY = {
    id: "11111111-1111-4111-8111-111111111111",
    ref: PROJECT_REF,
    organization_id: "22222222-2222-4222-8222-222222222222",
    organization_slug: "example-organization",
    name: "Example project",
    region: "local",
    created_at: "2026-08-12T00:00:00.000Z",
    status: "ACTIVE_HEALTHY",
};
const PROJECT_DETAILS = {
    ...PROJECT_SUMMARY,
    database: {
        host: "db.example.test",
        version: "17.5",
        postgres_engine: "17",
        release_channel: "stable",
    },
    api: { url: "https://api.example.test" },
    studio: { url: "https://studio.example.test" },
};

describe("project CLI reads", () => {
    test("bounds and projects the user project get response", async () => {
        const remoteSecret = "user-project-private-sentinel";
        let request: { path: string; maxResponseBytes?: number } | undefined;
        const callback = captureProjectTool({
            get: async (path: string, options?: { maxResponseBytes?: number }) => {
                request = { path, maxResponseBytes: options?.maxResponseBytes };
                return {
                    ok: true,
                    status: 200,
                    data: {
                        ...PROJECT_DETAILS,
                        config: { private_runtime_value: remoteSecret },
                        anon_key: remoteSecret,
                        services: [{ token: remoteSecret }],
                    },
                };
            },
        }, PROJECT_REF);

        const response = await callback({ action: "get" });

        expect(request).toEqual({
            path: `/v1/projects/${PROJECT_REF}`,
            maxResponseBytes: 1_048_576,
        });
        expect(response.isError).not.toBe(true);
        expect(JSON.parse(response.content[0].text)).toEqual(PROJECT_DETAILS);
        expect(response.content[0].text).not.toContain(remoteSecret);
    });

    test("fails malformed user and retained Admin reads without reflection", async () => {
        const remoteSecret = "invalid-project-read-sentinel";
        const http = {
            get: async () => ({
                ok: true,
                status: 200,
                data: { ...PROJECT_DETAILS, credentials: { service_role_key: remoteSecret } },
            }),
        };
        const userResponse = await captureProjectTool(http, PROJECT_REF)({ action: "get" });
        const adminResponse = await captureAdminProjectTool(http)({ action: "get", ref: PROJECT_REF });

        for (const response of [userResponse, adminResponse]) {
            expect(response.isError).toBe(true);
            expect(response.content[0].text).toBe("❌ Invalid project response");
            expect(response.content[0].text).not.toContain(remoteSecret);
        }
    });
});

describe("project CLI task actions", () => {
    test("prefers an explicit ref over the auto-linked project", async () => {
        const calls: string[] = [];
        const callback = captureProjectTool({
            get: async (path: string) => {
                calls.push(path);
                return { ok: true, status: 200, data: {} };
            },
        }, "default-ref");

        await callback({ action: "get", ref: "override-ref" });

        expect(calls).toEqual(["/v1/projects/override-ref"]);
    });

    test("retrieves task detail and formats latest logs", async () => {
        const calls: string[] = [];
        const callback = captureProjectTool({
            get: async (path: string) => {
                calls.push(path);
                return {
                    ok: true,
                    status: 200,
                    data: {
                        id: "task_1",
                        task_type: "queue:emails",
                        status: "failed",
                        attempt: 2,
                        max_attempts: 3,
                        latest_logs: [{ stream: "stderr", message: "boom" }],
                    },
                };
            },
        });

        const result = await callback({ action: "task_detail", task_id: "task_1" });

        expect(calls).toEqual(["/v1/projects/proj/tasks/task_1"]);
        expect(result.content[0].text).toContain("Task Detail");
        expect(result.content[0].text).toContain("boom");
    });

    test("retrieves task stats", async () => {
        const calls: string[] = [];
        const callback = captureProjectTool({
            get: async (path: string) => {
                calls.push(path);
                return { ok: true, status: 200, data: { pending: 1, failed: 2 } };
            },
        });

        const result = await callback({ action: "task_stats" });

        expect(calls).toEqual(["/v1/projects/proj/tasks/stats"]);
        expect(result.content[0].text).toContain("Task Stats");
    });
});

describe("admin project create compatibility", () => {
    test("forwards custom domains through the retained admin registration", async () => {
        const requests: Array<{ path: string; body: unknown }> = [];
        const callback = captureAdminProjectTool({
            post: async (path: string, body: unknown) => {
                requests.push({ path, body });
                return { ok: true, status: 201, data: { ref: "project-ref" } };
            },
        });

        await callback({
            action: "create",
            name: "domain-project",
            domain: "Example.COM",
            api_domain: "API.Example.COM",
            auth_domain: "Auth.Example.COM",
            studio_domain: "Studio.Example.COM",
        });

        expect(requests).toEqual([{
            path: "/v1/projects",
            body: {
                name: "domain-project",
                region: "local",
                organization_id: undefined,
                domain: "Example.COM",
                api_domain: "API.Example.COM",
                auth_domain: "Auth.Example.COM",
                studio_domain: "Studio.Example.COM",
            },
        }]);
    });

    test("does not expose admin create fields through the user project registration", () => {
        let userProjectSchema: ToolSchema | undefined;
        registerUserProjectCliTools({
            tool(name: string, _description: string, schema: ToolSchema) {
                if (name === "project") userProjectSchema = schema;
            },
        }, {} as any, { projectRef: "proj" });

        if (!userProjectSchema) throw new Error("user project tool was not registered");
        expect(schemaEnumValues(userProjectSchema.action)).not.toContain("create");
        expect(userProjectSchema.domain).toBeUndefined();
        expect(userProjectSchema.api_domain).toBeUndefined();
        expect(userProjectSchema.auth_domain).toBeUndefined();
        expect(userProjectSchema.studio_domain).toBeUndefined();
    });
});
