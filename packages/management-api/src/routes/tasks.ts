import { Elysia, status, t } from "elysia";
import { taskRepository } from "../repositories/task.repository";
import { TaskStatus, type ProjectTask } from "../db";
import { backgroundFunctionWorker, projectService } from "../services";
import { pgmqService } from "../services/pgmq.service";
import * as authMiddleware from "../middleware/auth";

const QUEUE_TASK_TYPE_PREFIX = "queue:";
const DEFAULT_QUEUE_VISIBILITY_TIMEOUT_SEC = 330;
const MAX_QUEUE_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

function normalizeQueueName(name: string): string | null {
    const value = name.trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(value)) return null;
    return value;
}

function queueTaskType(name: string): string {
    return `${QUEUE_TASK_TYPE_PREFIX}${name}`;
}

function normalizePositiveInteger(value: unknown, fallback: number, min: number, max: number): number {
    const numberValue = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numberValue)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(numberValue)));
}

function normalizeNonNegativeSeconds(value: unknown, fallback: number, max: number): number {
    return normalizePositiveInteger(value, fallback, 0, max);
}

function normalizeMessageId(value: string): number | null {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isTaskDetailRead(request: Request, projectRef: string): boolean {
    if (request.method !== "GET") return false;
    const pathname = new URL(request.url).pathname;
    const prefix = `/v1/projects/${projectRef}/tasks/`;
    if (!pathname.startsWith(prefix)) return false;
    const suffix = pathname.slice(prefix.length);
    return suffix.length > 0 && !suffix.includes("/");
}

function taskInvokerUserId(task: ProjectTask): string | null {
    const auth = task.payload?.auth;
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) return null;
    const userId = (auth as Record<string, unknown>).invoker_user_id;
    return typeof userId === "string" && userId.length > 0 ? userId : null;
}

function redactTaskPayloadForInvoker(payload: Record<string, unknown>): Record<string, unknown> {
    const auth = payload.auth;
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) return payload;
    return {
        ...payload,
        auth: {
            ...(auth as Record<string, unknown>),
            authorization: null,
            apikey: null,
        },
    };
}

async function getTaskDetailAuth(
    request: Request,
    projectRef: string,
    task: ProjectTask,
): Promise<{ allowed: true; invoker: boolean } | { allowed: false; status: number; body: { error: string } }> {
    const authorization = request.headers.get("authorization") || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (token) {
        const jwt = await authMiddleware.verifyProjectJwt(token, projectRef);
        const invokerUserId = taskInvokerUserId(task);
        if (jwt?.ref === projectRef && jwt.role !== "anon" && jwt.sub && invokerUserId === jwt.sub) {
            return { allowed: true, invoker: true };
        }
        if (jwt?.ref === projectRef && jwt.role !== "anon" && jwt.sub) {
            return { allowed: false, status: 403, body: { error: "Task belongs to another user" } };
        }
    }

    const projectAuthError = await authMiddleware.requireProjectOrAdminAuth(request, projectRef);
    if (!projectAuthError) return { allowed: true, invoker: false };

    return { allowed: false, status: projectAuthError.status, body: projectAuthError.body };
}

export const taskRoutes = new Elysia({ prefix: "/v1/projects/:ref/tasks" })
    .onBeforeHandle(async ({ params, request }) => {
        if (isTaskDetailRead(request, params.ref)) return;
        const authError = await authMiddleware.requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status, authError.body);
    })
    .get("/queues", async ({ params }) => {
        try {
            return await pgmqService.listQueues(params.ref);
        } catch (err: unknown) {
            return status(500, { message: "Failed to list queues", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, { detail: { tags: ["tasks"], summary: "List PGMQ queues" } })
    .post("/queues", async ({ params, body }) => {
        try {
            const input = body as { queueName?: string; queue_name?: string; unlogged?: boolean };
            const queueName = normalizeQueueName(input.queueName || input.queue_name || "");
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }
            await pgmqService.createQueue(params.ref, queueName, { unlogged: input.unlogged });
            return status(201, { queue_name: queueName, type: input.unlogged ? "unlogged" : "basic" });
        } catch (err: unknown) {
            return status(500, { message: "Failed to create queue", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, {
        body: t.Object({
            queueName: t.Optional(t.String()),
            queue_name: t.Optional(t.String()),
            unlogged: t.Optional(t.Boolean()),
        }),
        detail: { tags: ["tasks"], summary: "Create a PGMQ queue" },
    })
    .delete("/queues/:queueName", async ({ params }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }
            const dropped = await pgmqService.dropQueue(params.ref, queueName);
            return dropped ? status(204) : status(404, { message: "Queue not found", code: "404" });
        } catch (err: unknown) {
            return status(500, { message: "Failed to drop queue", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, { detail: { tags: ["tasks"], summary: "Drop a PGMQ queue" } })
    .post("/queues/:queueName/messages", async ({ params, body }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            const input = body as {
                payload?: Record<string, unknown>;
                message?: Record<string, unknown>;
                delayMs?: number;
                sleepSeconds?: number;
                sleep_seconds?: number;
            };
            const sleepSeconds = input.sleepSeconds ?? input.sleep_seconds ??
                Math.floor(normalizeNonNegativeSeconds(input.delayMs, 0, MAX_QUEUE_DELAY_MS) / 1000);
            const msgId = await pgmqService.send(
                params.ref,
                queueName,
                input.message || input.payload || {},
                normalizeNonNegativeSeconds(sleepSeconds, 0, MAX_QUEUE_DELAY_MS / 1000),
            );
            return status(202, {
                id: String(msgId),
                msg_id: msgId,
                queue_name: queueName,
                task_type: queueTaskType(queueName),
                status: "pending",
            });
        } catch (err: unknown) {
            return status(500, { message: "Failed to enqueue queue message", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, {
        body: t.Object({
            payload: t.Optional(t.Record(t.String(), t.Unknown())),
            message: t.Optional(t.Record(t.String(), t.Unknown())),
            delayMs: t.Optional(t.Number()),
            sleepSeconds: t.Optional(t.Number()),
            sleep_seconds: t.Optional(t.Number()),
        }),
        detail: { tags: ["tasks"], summary: "Enqueue a PGMQ message" },
    })
    .post("/queues/:queueName/messages/batch", async ({ params, body }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }
            const input = body as { messages?: Record<string, unknown>[]; sleepSeconds?: number; sleep_seconds?: number; delayMs?: number };
            const messages = Array.isArray(input.messages) ? input.messages : [];
            const sleepSeconds = input.sleepSeconds ?? input.sleep_seconds ??
                Math.floor(normalizeNonNegativeSeconds(input.delayMs, 0, MAX_QUEUE_DELAY_MS) / 1000);
            const ids = await pgmqService.sendBatch(
                params.ref,
                queueName,
                messages,
                normalizeNonNegativeSeconds(sleepSeconds, 0, MAX_QUEUE_DELAY_MS / 1000),
            );
            return status(202, {
                queue_name: queueName,
                task_type: queueTaskType(queueName),
                msg_ids: ids,
                count: ids.length,
            });
        } catch (err: unknown) {
            return status(500, { message: "Failed to enqueue queue message batch", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, {
        body: t.Object({
            messages: t.Array(t.Record(t.String(), t.Unknown())),
            delayMs: t.Optional(t.Number()),
            sleepSeconds: t.Optional(t.Number()),
            sleep_seconds: t.Optional(t.Number()),
        }),
        detail: { tags: ["tasks"], summary: "Enqueue a PGMQ message batch" },
    })
    .post("/queues/:queueName/messages/receive", async ({ params, body }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            const input = body as { visibilityTimeoutSec?: number; sleep_seconds?: number; n?: number; count?: number } | undefined;
            const queueSettings = await projectService.getQueueSettings(params.ref, queueName);
            if (!queueSettings) {
                return status(404, { message: "Project not found", code: "404" });
            }
            const messages = await pgmqService.read(
                params.ref,
                queueName,
                normalizePositiveInteger(
                    input?.sleep_seconds ?? input?.visibilityTimeoutSec,
                    queueSettings.default_visibility_timeout_sec || DEFAULT_QUEUE_VISIBILITY_TIMEOUT_SEC,
                    1,
                    1800,
                ),
                normalizePositiveInteger(input?.n ?? input?.count, 1, 1, Math.max(1, queueSettings.max_in_flight)),
            );
            if (messages.length === 0) return status(204);
            return (input?.n ?? input?.count) ? messages : messages[0];
        } catch (err: unknown) {
            return status(500, { message: "Failed to receive queue message", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, {
        body: t.Optional(t.Object({
            visibilityTimeoutSec: t.Optional(t.Number()),
            sleep_seconds: t.Optional(t.Number()),
            n: t.Optional(t.Number()),
            count: t.Optional(t.Number()),
        })),
        detail: { tags: ["tasks"], summary: "Read PGMQ messages with a visibility timeout" },
    })
    .get("/queues/:queueName/messages", async ({ params, query }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            return await pgmqService.listMessages(params.ref, queueName, {
                archived: query.archived === "true" || query.dlq === "true",
                limit: normalizePositiveInteger(query.limit, 50, 1, 500),
            });
        } catch (err: unknown) {
            return status(500, { message: "Failed to list queue messages", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, {
        query: t.Optional(t.Object({
            archived: t.Optional(t.String()),
            dlq: t.Optional(t.String()),
            limit: t.Optional(t.String()),
        })),
        detail: { tags: ["tasks"], summary: "List PGMQ messages for operator diagnostics" },
    })
    .post("/queues/:queueName/messages/pop", async ({ params }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            const message = await pgmqService.pop(params.ref, queueName);
            if (!message) return status(204);
            return message;
        } catch (err: unknown) {
            return status(500, { message: "Failed to pop queue message", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, { detail: { tags: ["tasks"], summary: "Pop and delete the next PGMQ message" } })
    .get("/queues/:queueName/stats", async ({ params }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            const metrics = await pgmqService.metrics(params.ref, queueName);
            return metrics || status(404, { message: "Queue not found", code: "404" });
        } catch (err: unknown) {
            return status(500, { message: "Failed to retrieve queue stats", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, { detail: { tags: ["tasks"], summary: "Get queue statistics" } })
    .post("/queues/:queueName/purge", async ({ params }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            return { queue_name: queueName, purged: await pgmqService.purge(params.ref, queueName) };
        } catch (err: unknown) {
            return status(500, { message: "Failed to purge queue", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, { detail: { tags: ["tasks"], summary: "Purge pending PGMQ messages" } })
    .get("/queues/:queueName/settings", async ({ params }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            const settings = await projectService.getQueueSettings(params.ref, queueName);
            if (!settings) return status(404, { message: "Project not found", code: "404" });
            return settings;
        } catch (err: unknown) {
            return status(500, { message: "Failed to retrieve queue settings", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, { detail: { tags: ["tasks"], summary: "Get queue settings" } })
    .patch("/queues/:queueName/settings", async ({ params, body }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            const input = body as {
                max_in_flight?: number;
                default_visibility_timeout_sec?: number;
                max_attempts?: number;
                rate_limit_per_minute?: number;
            };
            const settings = await projectService.updateQueueSettings(params.ref, queueName, {
                max_in_flight: input.max_in_flight,
                default_visibility_timeout_sec: input.default_visibility_timeout_sec,
                max_attempts: input.max_attempts,
                rate_limit_per_minute: input.rate_limit_per_minute,
            });
            if (!settings) return status(404, { message: "Project not found", code: "404" });
            return settings;
        } catch (err: unknown) {
            return status(500, { message: "Failed to update queue settings", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, {
        body: t.Object({
            max_in_flight: t.Optional(t.Number()),
            default_visibility_timeout_sec: t.Optional(t.Number()),
            max_attempts: t.Optional(t.Number()),
            rate_limit_per_minute: t.Optional(t.Number()),
        }),
        detail: { tags: ["tasks"], summary: "Update queue settings" },
    })
    .get("/queues/:queueName/messages/:messageId", async ({ params }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            return status(410, {
                message: "PGMQ does not expose random message lookup through the official queue API; use receive/read, stats, archive, or delete",
                code: "410",
            });
        } catch (err: unknown) {
            return status(500, { message: "Failed to retrieve queue message", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, { detail: { tags: ["tasks"], summary: "Get a queue message by ID" } })
    .post("/queues/:queueName/messages/:messageId/ack", async ({ params }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            const messageId = normalizeMessageId(params.messageId);
            if (!messageId) {
                return status(400, { message: "Invalid queue message ID", code: "400" });
            }
            const archived = await pgmqService.archive(params.ref, queueName, messageId);
            if (!archived) {
                return status(409, { message: "Queue message is not currently leased", code: "409" });
            }
            return { id: String(messageId), msg_id: messageId, queue_name: queueName, status: "archived" };
        } catch (err: unknown) {
            return status(500, { message: "Failed to acknowledge queue message", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, {
        body: t.Optional(t.Object({
            result: t.Optional(t.Record(t.String(), t.Unknown())),
        })),
        detail: { tags: ["tasks"], summary: "Acknowledge a queue message" },
    })
    .post("/queues/:queueName/messages/:messageId/release", async ({ params, body }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            const messageId = normalizeMessageId(params.messageId);
            if (!messageId) {
                return status(400, { message: "Invalid queue message ID", code: "400" });
            }
            const input = body as { delayMs?: number; sleep_seconds?: number } | undefined;
            const sleepSeconds = input?.sleep_seconds ??
                Math.floor(normalizeNonNegativeSeconds(input?.delayMs, 0, MAX_QUEUE_DELAY_MS) / 1000);
            const task = await pgmqService.setVisibilityTimeout(
                params.ref,
                queueName,
                messageId,
                normalizeNonNegativeSeconds(sleepSeconds, 0, MAX_QUEUE_DELAY_MS / 1000),
            );
            return task || status(404, { message: "Queue message not found", code: "404" });
        } catch (err: unknown) {
            return status(500, { message: "Failed to release queue message", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, {
        body: t.Optional(t.Object({
            delayMs: t.Optional(t.Number()),
            sleep_seconds: t.Optional(t.Number()),
        })),
        detail: { tags: ["tasks"], summary: "Release a queue message back to the queue" },
    })
    .post("/queues/:queueName/messages/:messageId/fail", async ({ params }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            const messageId = normalizeMessageId(params.messageId);
            if (!messageId) {
                return status(400, { message: "Invalid queue message ID", code: "400" });
            }
            const archived = await pgmqService.archive(params.ref, queueName, messageId);
            return archived
                ? { id: String(messageId), msg_id: messageId, queue_name: queueName, status: "archived" }
                : status(404, { message: "Queue message not found", code: "404" });
        } catch (err: unknown) {
            return status(500, { message: "Failed to fail queue message", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, {
        body: t.Optional(t.Object({
            error: t.Optional(t.String()),
            deadLetter: t.Optional(t.Boolean()),
        })),
        detail: { tags: ["tasks"], summary: "Mark a queue message as failed" },
    })
    .post("/queues/:queueName/messages/:messageId/retry", async ({ params }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            return status(410, {
                message: "PGMQ archived messages are retained for replay via SQL/archive workflows; direct retry is not part of the official queue API",
                code: "410",
            });
        } catch (err: unknown) {
            return status(500, { message: "Failed to retry queue message", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, { detail: { tags: ["tasks"], summary: "Retry a dead-lettered queue message" } })
    .delete("/queues/:queueName/messages/:messageId", async ({ params }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            const messageId = normalizeMessageId(params.messageId);
            if (!messageId) {
                return status(400, { message: "Invalid queue message ID", code: "400" });
            }
            const deleted = await pgmqService.deleteMessage(params.ref, queueName, messageId);
            if (!deleted) {
                return status(404, { message: "Queue message not found", code: "404" });
            }
            return status(204);
        } catch (err: unknown) {
            return status(500, { message: "Failed to delete queue message", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, { detail: { tags: ["tasks"], summary: "Delete a queue message" } })
    .get("/", async ({ params, query }) => {
        try {
            const statuses = typeof query.status === "string"
              ? query.status.split(",").map((value) => value.trim()).filter(Boolean)
              : undefined;
            const taskTypes = typeof query.task_type === "string"
              ? query.task_type.split(",").map((value) => value.trim()).filter(Boolean)
              : undefined;
            const functionSlug = typeof query.function_slug === "string" && query.function_slug.trim().length > 0
              ? query.function_slug.trim()
              : undefined;
            const functionVersion = typeof query.function_version === "string" && query.function_version.trim().length > 0
              ? query.function_version.trim()
              : undefined;
            const limit = typeof query.limit === "string" ? Number.parseInt(query.limit, 10) : 50;
            const tasks = await taskRepository.listTasksByProjectFiltered(params.ref, {
              statuses,
              taskTypes,
              functionSlug,
              functionVersion,
              onlyDeadLettered: query.dlq === "true",
              limit: Number.isFinite(limit) ? limit : 50,
              summary: query.summary === "true",
            });
            return tasks;
        } catch (err: unknown) {
                        return status(500, { message: "Failed to retrieve tasks", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, {
        query: t.Optional(t.Object({
            status: t.Optional(t.String()),
            task_type: t.Optional(t.String()),
            function_slug: t.Optional(t.String()),
            function_version: t.Optional(t.String()),
            dlq: t.Optional(t.String()),
            limit: t.Optional(t.String()),
            summary: t.Optional(t.String()),
        })),
        detail: { tags: ["tasks"], summary: "List project tasks" },
    })
    .get("/settings/background", async ({ params }) => {
        try {
            const settings = await projectService.getBackgroundTaskSettings(params.ref);
            if (!settings) {
                return status(404, { message: "Project not found", code: "404" });
            }
            return settings;
        } catch (err: unknown) {
            return status(500, { message: "Failed to retrieve background task settings", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, { detail: { tags: ["tasks"], summary: "Get background task settings" } })
    .get("/dlq", async ({ params, query }) => {
        try {
            const tasks = await taskRepository.listTasksByProjectFiltered(params.ref, {
                onlyDeadLettered: true,
                limit: 100,
                summary: query.summary === "true",
            });
            return tasks;
        } catch (err: unknown) {
            return status(500, { message: "Failed to retrieve DLQ tasks", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, {
        query: t.Optional(t.Object({
            summary: t.Optional(t.String()),
        })),
        detail: { tags: ["tasks"], summary: "List dead-lettered tasks" },
    })
    .get("/stats", async ({ params }) => {
        try {
            return await taskRepository.getTaskStats(params.ref);
        } catch (err: unknown) {
            return status(500, { message: "Failed to retrieve task stats", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, { detail: { tags: ["tasks"], summary: "Get task statistics" } })
    .patch("/settings/background", async ({ params, body }) => {
        try {
            const settings = await projectService.updateBackgroundTaskSettings(params.ref, body as Record<string, number>);
            if (!settings) {
                return status(404, { message: "Project not found", code: "404" });
            }
            return settings;
        } catch (err: unknown) {
            return status(500, { message: "Failed to update background task settings", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, {
        body: t.Object({
            concurrency: t.Optional(t.Number()),
            max_attempts: t.Optional(t.Number()),
            max_payload_bytes: t.Optional(t.Number()),
            timeout_sec_default: t.Optional(t.Number()),
            timeout_sec_max: t.Optional(t.Number()),
        }),
        detail: { tags: ["tasks"], summary: "Update background task settings" },
    })
    .get("/:taskId", async ({ params, request }) => {
        try {
            const task = await taskRepository.getTaskById(params.taskId, params.ref);
            if (!task) {
                return status(404, { message: "Task not found", code: "404" });
            }
            const auth = await getTaskDetailAuth(request, params.ref, task);
            if (!auth.allowed) return status(auth.status, auth.body);

            const attempts = await taskRepository.listTaskAttempts(params.taskId);
            const latestAttempt = attempts[0] || null;
            return {
                ...task,
                payload: auth.invoker ? redactTaskPayloadForInvoker(task.payload) : task.payload,
                attempts,
                latest_logs: latestAttempt?.logs || [],
            };
        } catch (err: unknown) {
            return status(500, { message: "Failed to retrieve task", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, { detail: { tags: ["tasks"], summary: "Get task details by ID" } })
    .post("/:taskId/cancel", async ({ params }) => {
        try {
            const current = await taskRepository.getTaskById(params.taskId, params.ref);
            if (!current) {
                return status(404, { message: "Task not found", code: "404" });
            }

            if (
                current.status === TaskStatus.SUCCEEDED ||
                current.status === TaskStatus.FAILED ||
                current.status === TaskStatus.DEAD_LETTERED ||
                current.status === TaskStatus.CANCELLED
            ) {
                return status(409, { message: "Task is already completed", code: "409" });
            }

            if (current.status === TaskStatus.RUNNING || current.status === TaskStatus.LEASED) {
                const requested = await backgroundFunctionWorker.cancel(params.taskId);
                if (!requested) {
                    return status(409, { message: "Task cancellation could not be scheduled", code: "409" });
                }
                const updated = await taskRepository.getTaskById(params.taskId, params.ref);
                if (!updated) {
                    return status(404, { message: "Task not found", code: "404" });
                }
                return updated;
            }

            const task = await backgroundFunctionWorker.cancel(params.taskId);
            if (!task) {
                return status(404, { message: "Task not found", code: "404" });
            }
            const updated = await taskRepository.getTaskById(params.taskId, params.ref);
            return updated || status(404, { message: "Task not found", code: "404" });
        } catch (err: unknown) {
            return status(500, { message: "Failed to cancel task", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, { detail: { tags: ["tasks"], summary: "Cancel a running task" } })
    .post("/:taskId/retry", async ({ params }) => {
        try {
            const task = await taskRepository.retryTask(params.taskId);
            if (!task) {
                return status(404, { message: "Task not found", code: "404" });
            }
            return task;
        } catch (err: unknown) {
            return status(500, { message: "Failed to retry task", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, { detail: { tags: ["tasks"], summary: "Retry a failed task" } });
