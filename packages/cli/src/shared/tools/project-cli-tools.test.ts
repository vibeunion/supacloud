import { describe, expect, test } from "bun:test";
import { schemaEnumValues, type ToolSchema } from "../schema";
import { registerAdminProjectCliTools, registerUserProjectCliTools } from "./project-cli-tools";

function captureProjectTool(http: Record<string, unknown>, projectRef = "proj") {
    let callback: ((args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) | undefined;
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
    let callback: ((args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) | undefined;
    registerAdminProjectCliTools({
        tool(name: string, _description: string, _schema: Record<string, unknown>, toolCallback: typeof callback) {
            if (name === "project") callback = toolCallback;
        },
    }, http as any);

    if (!callback) throw new Error("admin project tool was not registered");
    return callback;
}

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
