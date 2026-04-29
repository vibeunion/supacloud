import { Elysia, status, t } from "elysia";
import { taskRepository } from "../repositories/task.repository";
import { TaskStatus } from "../db";
import { backgroundFunctionWorker, projectService } from "../services";
import { requireProjectOrAdminAuth } from "../middleware/auth";

const QUEUE_TASK_TYPE_PREFIX = "queue:";
const DEFAULT_QUEUE_MAX_ATTEMPTS = 3;
const DEFAULT_QUEUE_VISIBILITY_TIMEOUT_SEC = 330;
const MAX_QUEUE_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

function normalizeQueueName(name: string): string | null {
    const value = name.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) return null;
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

function buildQueueListFilters(queueName: string, query: Record<string, unknown>) {
    const statuses = typeof query.status === "string"
      ? query.status.split(",").map((value) => value.trim()).filter(Boolean)
      : undefined;
    const limit = normalizePositiveInteger(query.limit, 50, 1, 500);
    return {
        statuses,
        taskTypes: [queueTaskType(queueName)],
        onlyDeadLettered: query.dlq === "true",
        limit,
    };
}

export const taskRoutes = new Elysia({ prefix: "/v1/projects/:ref/tasks" })
    .onBeforeHandle(async ({ params, request }) => {
        const authError = await requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status, authError.body);
    })
    .post("/queues/:queueName/messages", async ({ params, body }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }
            const queueSettings = await projectService.getQueueSettings(params.ref, queueName);
            if (!queueSettings) {
                return status(404, { message: "Project not found", code: "404" });
            }

            const input = body as {
                payload?: Record<string, unknown>;
                delayMs?: number;
                maxAttempts?: number;
                idempotencyKey?: string;
                traceId?: string;
            };
            const recentMessages = await taskRepository.countQueueMessagesCreatedSince(
                params.ref,
                queueTaskType(queueName),
                new Date(Date.now() - 60_000),
            );
            if (recentMessages >= queueSettings.rate_limit_per_minute) {
                return status(429, {
                    message: "Queue rate limit exceeded",
                    code: "429",
                    limit: queueSettings.rate_limit_per_minute,
                    window_seconds: 60,
                });
            }
            const delayMs = normalizePositiveInteger(input.delayMs, 0, 0, MAX_QUEUE_DELAY_MS);
            const task = await taskRepository.createTask({
                ref: params.ref,
                type: queueTaskType(queueName),
                payload: input.payload || {},
                maxAttempts: normalizePositiveInteger(input.maxAttempts, queueSettings.max_attempts, 1, 10),
                nextRunAt: new Date(Date.now() + delayMs),
                idempotencyKey: input.idempotencyKey || null,
                traceId: input.traceId || null,
            });
            return status(202, task);
        } catch (err: unknown) {
            return status(500, { message: "Failed to enqueue queue message", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, {
        body: t.Object({
            payload: t.Optional(t.Record(t.String(), t.Unknown())),
            delayMs: t.Optional(t.Number()),
            maxAttempts: t.Optional(t.Number()),
            idempotencyKey: t.Optional(t.String()),
            traceId: t.Optional(t.String()),
        }),
    })
    .post("/queues/:queueName/messages/receive", async ({ params, body }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            const input = body as { visibilityTimeoutSec?: number } | undefined;
            const queueSettings = await projectService.getQueueSettings(params.ref, queueName);
            if (!queueSettings) {
                return status(404, { message: "Project not found", code: "404" });
            }
            const task = await taskRepository.claimQueueMessage({
                projectRef: params.ref,
                queueName: queueTaskType(queueName),
                visibilityTimeoutSec: normalizePositiveInteger(
                    input?.visibilityTimeoutSec,
                    queueSettings.default_visibility_timeout_sec || DEFAULT_QUEUE_VISIBILITY_TIMEOUT_SEC,
                    1,
                    1800,
                ),
                maxInFlight: queueSettings.max_in_flight,
            });
            if (!task) return status(204);
            return task;
        } catch (err: unknown) {
            return status(500, { message: "Failed to receive queue message", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, {
        body: t.Optional(t.Object({
            visibilityTimeoutSec: t.Optional(t.Number()),
        })),
    })
    .get("/queues/:queueName/messages", async ({ params, query }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            return await taskRepository.listTasksByProjectFiltered(params.ref, buildQueueListFilters(queueName, query));
        } catch (err: unknown) {
            return status(500, { message: "Failed to list queue messages", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, {
        query: t.Optional(t.Object({
            status: t.Optional(t.String()),
            dlq: t.Optional(t.String()),
            limit: t.Optional(t.String()),
        })),
    })
    .get("/queues/:queueName/stats", async ({ params }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            return await taskRepository.getQueueStats(params.ref, queueTaskType(queueName));
        } catch (err: unknown) {
            return status(500, { message: "Failed to retrieve queue stats", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    })
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
    })
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
    })
    .get("/queues/:queueName/messages/:messageId", async ({ params }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            const task = await taskRepository.getTaskByIdAndType(params.messageId, params.ref, queueTaskType(queueName));
            if (!task) {
                return status(404, { message: "Queue message not found", code: "404" });
            }
            const attempts = await taskRepository.listTaskAttempts(params.messageId);
            const latestAttempt = attempts[0] || null;
            return {
                ...task,
                attempts,
                latest_logs: latestAttempt?.logs || [],
            };
        } catch (err: unknown) {
            return status(500, { message: "Failed to retrieve queue message", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    })
    .post("/queues/:queueName/messages/:messageId/ack", async ({ params, body }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            const current = await taskRepository.getTaskByIdAndType(params.messageId, params.ref, queueTaskType(queueName));
            if (!current) {
                return status(404, { message: "Queue message not found", code: "404" });
            }
            const input = body as { result?: Record<string, unknown> } | undefined;
            const task = await taskRepository.acknowledgeQueueMessage(params.messageId, input?.result || null);
            if (!task) {
                return status(409, { message: "Queue message is not currently leased", code: "409" });
            }
            return task;
        } catch (err: unknown) {
            return status(500, { message: "Failed to acknowledge queue message", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, {
        body: t.Optional(t.Object({
            result: t.Optional(t.Record(t.String(), t.Unknown())),
        })),
    })
    .post("/queues/:queueName/messages/:messageId/release", async ({ params, body }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            const current = await taskRepository.getTaskByIdAndType(params.messageId, params.ref, queueTaskType(queueName));
            if (!current) {
                return status(404, { message: "Queue message not found", code: "404" });
            }
            const input = body as { delayMs?: number; error?: string } | undefined;
            const delayMs = normalizePositiveInteger(input?.delayMs, 0, 0, MAX_QUEUE_DELAY_MS);
            const task = await taskRepository.releaseTask(params.messageId, new Date(Date.now() + delayMs), input?.error);
            return task || status(404, { message: "Queue message not found", code: "404" });
        } catch (err: unknown) {
            return status(500, { message: "Failed to release queue message", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, {
        body: t.Optional(t.Object({
            delayMs: t.Optional(t.Number()),
            error: t.Optional(t.String()),
        })),
    })
    .post("/queues/:queueName/messages/:messageId/fail", async ({ params, body }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            const current = await taskRepository.getTaskByIdAndType(params.messageId, params.ref, queueTaskType(queueName));
            if (!current) {
                return status(404, { message: "Queue message not found", code: "404" });
            }
            const input = body as { error?: string; deadLetter?: boolean } | undefined;
            const task = await taskRepository.markTaskFailed(params.messageId, input?.error || "Queue message failed", input?.deadLetter ?? true);
            return task || status(404, { message: "Queue message not found", code: "404" });
        } catch (err: unknown) {
            return status(500, { message: "Failed to fail queue message", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, {
        body: t.Optional(t.Object({
            error: t.Optional(t.String()),
            deadLetter: t.Optional(t.Boolean()),
        })),
    })
    .post("/queues/:queueName/messages/:messageId/retry", async ({ params }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            const task = await taskRepository.retryQueueMessage(params.messageId, params.ref, queueTaskType(queueName));
            if (!task) {
                return status(409, { message: "Queue message cannot be replayed from its current state", code: "409" });
            }
            return task;
        } catch (err: unknown) {
            return status(500, { message: "Failed to retry queue message", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    })
    .delete("/queues/:queueName/messages/:messageId", async ({ params }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            const current = await taskRepository.getTaskByIdAndType(params.messageId, params.ref, queueTaskType(queueName));
            if (!current) {
                return status(404, { message: "Queue message not found", code: "404" });
            }
            await taskRepository.cancelTask(params.messageId, "Deleted by queue client");
            return status(204);
        } catch (err: unknown) {
            return status(500, { message: "Failed to delete queue message", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    })
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
        })),
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
    })
    .get("/dlq", async ({ params }) => {
        try {
            const tasks = await taskRepository.listTasksByProjectFiltered(params.ref, {
                onlyDeadLettered: true,
                limit: 100,
            });
            return tasks;
        } catch (err: unknown) {
            return status(500, { message: "Failed to retrieve DLQ tasks", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    })
    .get("/stats", async ({ params }) => {
        try {
            return await taskRepository.getTaskStats(params.ref);
        } catch (err: unknown) {
            return status(500, { message: "Failed to retrieve task stats", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    })
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
    })
    .get("/:taskId", async ({ params }) => {
        try {
            const task = await taskRepository.getTaskById(params.taskId, params.ref);
            if (!task) {
                return status(404, { message: "Task not found", code: "404" });
            }
            const attempts = await taskRepository.listTaskAttempts(params.taskId);
            const latestAttempt = attempts[0] || null;
            return {
                ...task,
                attempts,
                latest_logs: latestAttempt?.logs || [],
            };
        } catch (err: unknown) {
            return status(500, { message: "Failed to retrieve task", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    })
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
    })
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
    });
