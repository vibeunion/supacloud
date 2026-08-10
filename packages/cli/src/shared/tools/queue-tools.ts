/**
 * Queue — Compound tool for message queue operations
 */
import { Type } from "@sinclair/typebox";
import { optional, stringEnum, withDescription } from "../schema";
import type { HttpTransport } from "../transports/http";

export interface QueueToolsConfig {
    projectRef?: string;
}

function formatQueueStats(data: unknown): string {
    if (!data || typeof data !== "object") return JSON.stringify(data, null, 2);
    const s = data as Record<string, unknown>;
    return [
        "📊 Queue Stats:",
        `  Pending:          ${s.pending ?? "?"}`,
        `  Leased:           ${s.leased ?? "?"}`,
        `  Running:          ${s.running ?? "?"}`,
        `  Retry Scheduled:  ${s.retryScheduled ?? s.retry_scheduled ?? "?"}`,
        `  Succeeded (24h):  ${s.succeededLast24h ?? s.succeeded_last_24h ?? "?"}`,
        `  Failed (24h):     ${s.failedLast24h ?? s.failed_last_24h ?? "?"}`,
        `  Dead Lettered:    ${s.deadLettered ?? s.dead_lettered ?? "?"}`,
        `  In Flight:        ${s.inFlight ?? s.in_flight ?? "?"}`,
        `  Oldest Pending:   ${s.oldestPendingAgeSec ?? s.oldest_pending_age_sec ?? "?"}s`,
    ].join("\n");
}

function formatQueueSettings(data: unknown): string {
    if (!data || typeof data !== "object") return JSON.stringify(data, null, 2);
    const s = data as Record<string, unknown>;
    return [
        "⚙️ Queue Settings:",
        `  Max In Flight:       ${s.max_in_flight ?? "?"}`,
        `  Visibility Timeout:  ${s.default_visibility_timeout_sec ?? "?"}s`,
        `  Max Attempts:        ${s.max_attempts ?? "?"}`,
        `  Rate Limit:          ${s.rate_limit_per_minute ?? "?"}/min`,
    ].join("\n");
}

function formatMessages(data: unknown, label = "Messages"): string {
    if (!Array.isArray(data)) return JSON.stringify(data, null, 2);
    if (data.length === 0) return `No ${label.toLowerCase()} found.`;
    const emoji: Record<string, string> = {
        pending: "⏳", leased: "🔓", running: "🔄", retry_scheduled: "🔁",
        succeeded: "✅", failed: "❌", dead_lettered: "💀",
    };
    let out = `${label} (${data.length}):\n\n`;
    for (const m of data as any[]) {
        const st = m.status || "?";
        out += `  ${emoji[st] || "❓"} ${st} — id: ${m.id}\n`;
        if (m.attempt != null) out += `     Attempt: ${m.attempt}/${m.max_attempts ?? "?"}\n`;
        if (m.error) out += `     Error: ${typeof m.error === "string" ? m.error : JSON.stringify(m.error)}\n`;
        if (m.created_at) out += `     Created: ${m.created_at}\n`;
        out += "\n";
    }
    return out;
}

function resolveRef(refFromArgs: string | undefined, defaultRef?: string): string {
    const ref = refFromArgs || defaultRef;
    if (!ref) throw new Error("'ref' is required for this action");
    return ref;
}

export function registerQueueTools(
    server: { tool: (...args: any[]) => void },
    http: HttpTransport,
    options: QueueToolsConfig = {},
): void {
    const { projectRef } = options;

    server.tool(
        "queue",
        `Message queue operations for task-based messaging.
Actions: list, stats, list_messages, dlq, get_message, send, receive, ack, release, fail, retry, delete_message, get_settings, update_settings`,
        {
            action: withDescription(stringEnum([
                "list", "stats", "list_messages", "dlq", "get_message",
                "send", "receive", "ack", "release", "fail", "retry", "delete_message",
                "get_settings", "update_settings",
            ]), "Action"),
            ref: optional(Type.String(), "Project ref"),
            queue: optional(Type.String(), "[list/stats/list_messages/dlq/get_message/send/receive/ack/release/fail/retry/delete_message/get_settings/update_settings] Queue name"),
            message_id: optional(Type.String(), "[get_message/ack/release/fail/retry/delete_message] Message ID"),
            // send
            payload: optional(Type.Record(Type.String(), Type.Unknown()), "[send] Message payload"),
            delay_ms: optional(Type.Number(), "[send] Delay in ms before message becomes visible"),
            max_attempts: optional(Type.Number(), "[send] Max delivery attempts"),
            idempotency_key: optional(Type.String(), "[send] Idempotency key for dedup"),
            correlation_id: optional(Type.String(), "[send] Correlation ID for tracing"),
            business_task_id: optional(Type.String(), "[send] Business task ID for cross-system mapping"),
            metadata: optional(Type.Record(Type.String(), Type.Unknown()), "[send] Arbitrary metadata attached to the message"),
            // receive
            visibility_timeout_sec: optional(Type.Number(), "[receive] Visibility timeout in seconds"),
            // list_messages / dlq
            status: optional(Type.String(), "[list_messages] Filter by status (comma-separated)"),
            limit: optional(Type.Number(), "[list_messages/dlq] Max messages to return"),
            // ack / release / fail
            result: optional(Type.Record(Type.String(), Type.Unknown()), "[ack] Ack result payload"),
            error: optional(Type.String(), "[release/fail] Error description"),
            delay_ms_release: optional(Type.Number(), "[release] Delay before message becomes visible again"),
            // update_settings
            max_in_flight: optional(Type.Number(), "[update_settings] Max concurrent in-flight messages"),
            default_visibility_timeout: optional(Type.Number(), "[update_settings] Default visibility timeout (sec)"),
            max_attempts_setting: optional(Type.Number(), "[update_settings] Max delivery attempts"),
            rate_limit: optional(Type.Number(), "[update_settings] Rate limit per minute"),
        },
        async (args: any) => {
            const resolvedRef = resolveRef(args.ref, projectRef);
            const q = args.queue;
            const need = (fields: string[]) => {
                for (const f of fields) {
                    if (!args[f]) throw new Error(`'${f}' is required for '${args.action}'`);
                }
            };
            const qBase = `/v1/projects/${resolvedRef}/tasks/queues/${q}`;
            let text: string;

            switch (args.action) {
                case "list": {
                    need(["queue"]);
                    const res = await http.get(`${qBase}/messages`);
                    text = res.ok ? formatMessages(res.data, `Queue ${q}`) : `❌ Failed (${res.status})`;
                    break;
                }
                case "stats": {
                    need(["queue"]);
                    const res = await http.get(`${qBase}/stats`);
                    text = res.ok ? formatQueueStats(res.data) : `❌ Failed (${res.status})`;
                    break;
                }
                case "list_messages": {
                    need(["queue"]);
                    const params: Record<string, string> = {};
                    if (args.status) params.status = args.status;
                    if (args.limit) params.limit = String(args.limit);
                    const qs = Object.keys(params).length ? `?${new URLSearchParams(params)}` : "";
                    const res = await http.get(`${qBase}/messages${qs}`);
                    text = res.ok ? formatMessages(res.data) : `❌ Failed (${res.status})`;
                    break;
                }
                case "dlq": {
                    need(["queue"]);
                    const params: Record<string, string> = { status: "dead_lettered" };
                    if (args.limit) params.limit = String(args.limit);
                    const res = await http.get(`${qBase}/messages?${new URLSearchParams(params)}`);
                    text = res.ok ? formatMessages(res.data, "Dead-Letter Messages") : `❌ Failed (${res.status})`;
                    break;
                }
                case "get_message": {
                    need(["queue", "message_id"]);
                    const res = await http.get(`${qBase}/messages/${args.message_id}`);
                    text = res.ok ? JSON.stringify(res.data, null, 2) : `❌ Failed (${res.status})`;
                    break;
                }
                case "send": {
                    need(["queue", "payload"]);
                    const body: Record<string, unknown> = {
                        payload: args.payload,
                        ...(args.delay_ms ? { delayMs: args.delay_ms } : {}),
                        ...(args.max_attempts ? { maxAttempts: args.max_attempts } : {}),
                        ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
                        ...(args.correlation_id ? { correlationId: args.correlation_id } : {}),
                        ...(args.business_task_id ? { businessTaskId: args.business_task_id } : {}),
                        ...(args.metadata ? { metadata: args.metadata } : {}),
                    };
                    const res = await http.post(`${qBase}/messages`, body);
                    text = res.ok
                        ? `✅ Message sent\n${JSON.stringify(res.data, null, 2)}`
                        : `❌ Failed (${res.status}): ${JSON.stringify(res.data)}`;
                    break;
                }
                case "receive": {
                    need(["queue"]);
                    const body: Record<string, unknown> = {};
                    if (args.visibility_timeout_sec) body.visibilityTimeoutSec = args.visibility_timeout_sec;
                    const res = await http.post(`${qBase}/messages/receive`, body);
                    if (!res.ok) { text = `❌ Failed (${res.status})`; break; }
                    text = res.data
                        ? JSON.stringify(res.data, null, 2)
                        : "📭 No messages available";
                    break;
                }
                case "ack": {
                    need(["queue", "message_id"]);
                    const body = args.result ? { result: args.result } : {};
                    const res = await http.post(`${qBase}/messages/${args.message_id}/ack`, body);
                    text = res.ok
                        ? `✅ Message ${args.message_id} acknowledged`
                        : `❌ Failed (${res.status})`;
                    break;
                }
                case "release": {
                    need(["queue", "message_id"]);
                    const body: Record<string, unknown> = {};
                    if (args.delay_ms_release) body.delayMs = args.delay_ms_release;
                    if (args.error) body.error = args.error;
                    const res = await http.post(`${qBase}/messages/${args.message_id}/release`, body);
                    text = res.ok
                        ? `✅ Message ${args.message_id} released back to queue`
                        : `❌ Failed (${res.status})`;
                    break;
                }
                case "fail": {
                    need(["queue", "message_id"]);
                    const body = args.error ? { error: args.error } : {};
                    const res = await http.post(`${qBase}/messages/${args.message_id}/fail`, body);
                    text = res.ok
                        ? `✅ Message ${args.message_id} marked as failed`
                        : `❌ Failed (${res.status})`;
                    break;
                }
                case "retry": {
                    need(["queue", "message_id"]);
                    const res = await http.post(`${qBase}/messages/${args.message_id}/retry`);
                    text = res.ok
                        ? `✅ Message ${args.message_id} queued for retry`
                        : `❌ Failed (${res.status})`;
                    break;
                }
                case "delete_message": {
                    need(["queue", "message_id"]);
                    const res = await http.delete(`${qBase}/messages/${args.message_id}`);
                    text = res.ok
                        ? `✅ Message ${args.message_id} deleted`
                        : `❌ Failed (${res.status})`;
                    break;
                }
                case "get_settings": {
                    need(["queue"]);
                    const res = await http.get(`${qBase}/settings`);
                    text = res.ok ? formatQueueSettings(res.data) : `❌ Failed (${res.status})`;
                    break;
                }
                case "update_settings": {
                    need(["queue"]);
                    const body: Record<string, unknown> = {};
                    if (args.max_in_flight) body.max_in_flight = args.max_in_flight;
                    if (args.default_visibility_timeout) body.default_visibility_timeout_sec = args.default_visibility_timeout;
                    if (args.max_attempts_setting) body.max_attempts = args.max_attempts_setting;
                    if (args.rate_limit) body.rate_limit_per_minute = args.rate_limit;
                    if (Object.keys(body).length === 0) throw new Error("At least one setting field is required");
                    const res = await http.patch(`${qBase}/settings`, body);
                    text = res.ok
                        ? `✅ Settings updated\n${formatQueueSettings(res.data)}`
                        : `❌ Failed (${res.status})`;
                    break;
                }
                default:
                    text = `❌ Unknown action: ${args.action}`;
            }

            return { content: [{ type: "text" as const, text }] };
        },
    );
}
