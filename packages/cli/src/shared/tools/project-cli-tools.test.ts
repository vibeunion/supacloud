import { describe, expect, test } from "bun:test";
import { registerUserProjectCliTools } from "./project-cli-tools";

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

describe("project CLI task actions", () => {
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
