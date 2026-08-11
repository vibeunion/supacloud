import { describe, expect, test } from "bun:test";
import { registerQueueTools } from "./queue-tools";

function captureQueueTool(http: Record<string, unknown>, projectRef?: string) {
    let schema: Record<string, unknown> | undefined;
    let callback: ((args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) | undefined;
    registerQueueTools({
        tool(name: string, _description: string, toolSchema: Record<string, unknown>, toolCallback: typeof callback) {
            if (name !== "queue") return;
            schema = toolSchema;
            callback = toolCallback;
        },
    }, http as any, { projectRef });

    if (!schema || !callback) throw new Error("queue tool was not registered");
    return { schema, callback };
}

describe("queue CLI tool", () => {
    test("prefers an explicit ref over the auto-linked project", async () => {
        const calls: string[] = [];
        const { callback } = captureQueueTool({
            get: async (path: string) => {
                calls.push(path);
                return { ok: true, status: 200, data: [] };
            },
        }, "default-ref");

        await callback({ action: "list", ref: "override-ref", queue: "emails" });

        expect(calls).toEqual(["/v1/projects/override-ref/tasks/queues/emails/messages"]);
    });

    test("sends queue messages with tracing metadata", async () => {
        const calls: Array<{ method: string; path: string; body: unknown }> = [];
        const { callback } = captureQueueTool({
            post: async (path: string, body: unknown) => {
                calls.push({ method: "post", path, body });
                return { ok: true, status: 200, data: { id: "msg_1" } };
            },
        });

        const result = await callback({
            action: "send",
            ref: "proj",
            queue: "emails",
            payload: { to: "user@example.com" },
            correlation_id: "corr-1",
            business_task_id: "biz-1",
            metadata: { source: "signup" },
        });

        expect(calls).toEqual([
            {
                method: "post",
                path: "/v1/projects/proj/tasks/queues/emails/messages",
                body: {
                    payload: { to: "user@example.com" },
                    correlationId: "corr-1",
                    businessTaskId: "biz-1",
                    metadata: { source: "signup" },
                },
            },
        ]);
        expect(result.content[0].text).toContain("Message sent");
    });

    test("retrieves queue settings and stats", async () => {
        const calls: Array<{ method: string; path: string }> = [];
        const { callback } = captureQueueTool({
            get: async (path: string) => {
                calls.push({ method: "get", path });
                if (path.endsWith("/stats")) {
                    return { ok: true, status: 200, data: { pending: 1, in_flight: 2 } };
                }
                return { ok: true, status: 200, data: { max_in_flight: 20, default_visibility_timeout_sec: 60, max_attempts: 3, rate_limit_per_minute: 100 } };
            },
        });

        await callback({ action: "stats", ref: "proj", queue: "emails" });
        const settings = await callback({ action: "get_settings", ref: "proj", queue: "emails" });

        expect(calls).toEqual([
            { method: "get", path: "/v1/projects/proj/tasks/queues/emails/stats" },
            { method: "get", path: "/v1/projects/proj/tasks/queues/emails/settings" },
        ]);
        expect(settings.content[0].text).toContain("Queue Settings");
    });
});
