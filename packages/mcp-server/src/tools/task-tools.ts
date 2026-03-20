/**
 * Task Queue Tools - Monitor task queue status
 * Maps to Management API: /v1/projects/:ref/tasks
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpTransport } from "../transports/http";

export function registerTaskTools(server: McpServer, http: HttpTransport): void {
    server.tool(
        "list_project_tasks",
        "List all tasks (provisioning, cleanup, etc.) for a project with their status",
        { ref: z.string().describe("Project ref") },
        async ({ ref }) => {
            const res = await http.get(`/v1/projects/${ref}/tasks`);
            return {
                content: [{
                    type: "text",
                    text: res.ok ? formatTasks(res.data) : `❌ Failed (${res.status})`,
                }],
            };
        }
    );
}

function formatTasks(data: unknown): string {
    if (!Array.isArray(data)) return JSON.stringify(data, null, 2);
    if (data.length === 0) return "No tasks found for this project.";

    const statusEmoji: Record<string, string> = {
        pending: "⏳",
        processing: "🔄",
        completed: "✅",
        failed: "❌",
    };

    let output = `📋 Project Tasks (${data.length}):\n\n`;
    for (const task of data) {
        const t = task as {
            id?: string; task_type?: string; status?: string;
            error?: string; retries?: number; created_at?: string;
        };
        const emoji = statusEmoji[t.status || ""] || "❓";
        output += `  ${emoji} ${t.task_type} — ${t.status}\n`;
        output += `     ID: ${t.id}\n`;
        if (t.retries && t.retries > 0) output += `     Retries: ${t.retries}\n`;
        if (t.error) output += `     Error: ${t.error}\n`;
        if (t.created_at) output += `     Created: ${t.created_at}\n`;
        output += "\n";
    }
    return output;
}
