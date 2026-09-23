import { Elysia, ParseError, status, t } from "elysia";
import { taskRepository } from "../repositories/task.repository";
import { TaskStatus, type ProjectTask } from "../db";
import { backgroundFunctionWorker, projectService } from "../services";
import { isPublicPgmqQueueName, pgmqService } from "../services/pgmq.service";
import * as authMiddleware from "../middleware/auth";
import { isRecord } from "../utils/project-config";
import { parsePgmqMessageId } from "../utils/pgmq-message-id";
import { PgmqInventoryError } from "../utils/pgmq-inventory";
import { pgmqInteger, PgmqInputError, PgmqPayloadTooLargeError } from "../utils/pgmq-input";
import { PgmqSettingsError, PgmqSettingsConflictError } from "../utils/pgmq-settings";
import { pgmqHttpDelay, pgmqHttpList, pgmqHttpReceive, pgmqHttpReceiveSettings } from "../utils/pgmq-http-input";
import { PgmqRequestBodyError } from "../utils/pgmq-request-body";
import { parseAuthorizedPgmqEnqueue, PgmqEnqueueAuthError } from "./pgmq-enqueue-parser";
import { PgmqMutationError } from "../utils/pgmq-mutation";
import { InvalidTaskListQueryError, parseTaskListQuery } from "../utils/task-list-query";
import { isPgflowTask, pgflowTaskService, PgflowTaskError, PgflowTaskReadError, startPgflowTask } from "../services/pgflow-task.service";

const QUEUE_TASK_TYPE_PREFIX = "queue:";

function normalizeQueueName(name: string): string | null {
    const normalizedName = name.trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(normalizedName) || !isPublicPgmqQueueName(normalizedName)) return null;
    return normalizedName;
}

function queueTaskType(name: string): string {
    return `${QUEUE_TASK_TYPE_PREFIX}${name}`;
}

function normalizeMessageId(value: string): string | null {
    try {
        return parsePgmqMessageId(value);
    } catch {
        return null;
    }
}

function isTaskDetailRead(request: Request, route: string): boolean {
    return request.method === "GET" && route === "/v1/projects/:ref/tasks/:taskId";
}

function taskInvokerUserId(task: ProjectTask): string | null {
    const auth = task.payload?.auth;
    if (!isRecord(auth)) return null;
    const userId = auth.invoker_user_id;
    return typeof userId === "string" && userId.length > 0 ? userId : null;
}

function redactTaskPayloadForInvoker(payload: Record<string, unknown>): Record<string, unknown> {
    const auth = payload.auth;
    if (!isRecord(auth)) return payload;
    return {
        ...payload,
        auth: {
            ...auth,
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
    .onError(({ error }) => {
        if (error instanceof PgflowTaskError) {
            return status(error.status, { message: error.message, code: "PGFLOW_TASK_ERROR" });
        }
        const cause = error instanceof ParseError ? error.cause : error;
        if (cause instanceof PgmqEnqueueAuthError) return status(cause.status, cause.body);
        if (cause instanceof PgmqRequestBodyError) {
            return status(cause.status, { message: "Queue request body could not be accepted", code: "PGMQ_REQUEST_BODY_INVALID" });
        }
    })
    .onBeforeHandle(async ({ params, request, route }) => {
        if (isTaskDetailRead(request, route)) return;
        const authError = await authMiddleware.requireProjectOrAdminAuth(request, params.ref);
        if (authError) return status(authError.status, authError.body);
    })
    .post("/flows", async ({ params, body }) => {
        try {
            return status(202, await startPgflowTask(params.ref, body));
        } catch (error) {
            if (error instanceof PgflowTaskError) throw error;
            return status(503, { message: "Flow submission could not be confirmed; retry with the same idempotency key", code: "PGFLOW_SUBMISSION_UNCONFIRMED" });
        }
    }, {
        body: t.Object({
            flow_slug: t.String({ minLength: 1, maxLength: 128 }),
            input: t.Unknown(),
            idempotency_key: t.String({ minLength: 1, maxLength: 200 }),
        }),
        detail: { tags: ["tasks"], summary: "Submit a pgflow execution as a project task" },
    })
    .get("/queues", async ({ params }) => {
        try {
            return await pgmqService.listQueues(params.ref);
        } catch (err: unknown) {
            return status(500, { message: "Failed to list queues", code: "500" });
        }
    }, { detail: { tags: ["tasks"], summary: "List PGMQ queues" } })
    .post("/queues", async ({ params, body }) => {
        try {
            const input = body;
            const queueName = normalizeQueueName(input.queueName || input.queue_name || "");
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }
            await pgmqService.createQueue(params.ref, queueName,
                input.unlogged === undefined ? {} : { unlogged: input.unlogged });
            return status(201, { queue_name: queueName, type: input.unlogged ? "unlogged" : "basic" });
        } catch (err: unknown) {
            if (err instanceof PgmqMutationError) return status(503, { message: "Queue creation could not be confirmed", code: "PGMQ_MUTATION_UNCONFIRMED", mutation_may_have_applied: true });
            if (err instanceof PgmqInputError) return status(400, { message: "Invalid queue input", code: "PGMQ_INPUT_INVALID" });
            return status(500, { message: "Failed to create queue", code: "500" });
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
            if (err instanceof PgmqInventoryError && err.mutationMayHaveApplied) {
                return status(503, { message: "Queue deletion could not be confirmed", code: "PGMQ_MUTATION_UNCONFIRMED", mutation_may_have_applied: true });
            }
            return status(500, { message: "Failed to drop queue", code: "500" });
        }
    }, { detail: { tags: ["tasks"], summary: "Drop a PGMQ queue" } })
    .post("/queues/:queueName/messages", async ({ params, body }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            const input = body;
            const sleepSeconds = pgmqHttpDelay(input);
            const msgId = await pgmqService.send(
                params.ref,
                queueName,
                input.message || input.payload || {},
                sleepSeconds,
            );
            return status(202, {
                id: String(msgId),
                msg_id: msgId,
                queue_name: queueName,
                task_type: queueTaskType(queueName),
                status: "pending",
            });
        } catch (err: unknown) {
            if (err instanceof PgmqMutationError) return status(503, { message: "Queue send could not be confirmed", code: "PGMQ_MUTATION_UNCONFIRMED", mutation_may_have_applied: true });
            if (err instanceof PgmqPayloadTooLargeError) return status(413, { message: "Queue payload exceeds limits", code: "PGMQ_PAYLOAD_TOO_LARGE" });
            if (err instanceof PgmqInputError) return status(400, { message: "Invalid queue input", code: "PGMQ_INPUT_INVALID" });
            return status(500, { message: "Failed to enqueue queue message", code: "500" });
        }
    }, {
        body: t.Object({
            payload: t.Optional(t.Record(t.String(), t.Unknown())),
            message: t.Optional(t.Record(t.String(), t.Unknown())),
            delayMs: t.Optional(t.Number()),
            sleepSeconds: t.Optional(t.Number()),
            sleep_seconds: t.Optional(t.Number()),
        }),
        parse: async ({ request, params }) => await parseAuthorizedPgmqEnqueue(request, params.ref, false),
        detail: { tags: ["tasks"], summary: "Enqueue a PGMQ message" },
    })
    .post("/queues/:queueName/messages/batch", async ({ params, body }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }
            const input = body;
            const messages = input.messages;
            const sleepSeconds = pgmqHttpDelay(input);
            const ids = await pgmqService.sendBatch(
                params.ref,
                queueName,
                messages,
                sleepSeconds,
            );
            return status(202, {
                queue_name: queueName,
                task_type: queueTaskType(queueName),
                msg_ids: ids,
                count: ids.length,
            });
        } catch (err: unknown) {
            if (err instanceof PgmqMutationError) return status(503, { message: "Queue batch send could not be confirmed", code: "PGMQ_MUTATION_UNCONFIRMED", mutation_may_have_applied: true });
            if (err instanceof PgmqPayloadTooLargeError) return status(413, { message: "Queue payload exceeds limits", code: "PGMQ_PAYLOAD_TOO_LARGE" });
            if (err instanceof PgmqInputError) return status(400, { message: "Invalid queue input", code: "PGMQ_INPUT_INVALID" });
            return status(500, { message: "Failed to enqueue queue message batch", code: "500" });
        }
    }, {
        body: t.Object({
            messages: t.Array(t.Record(t.String(), t.Unknown())),
            delayMs: t.Optional(t.Number()),
            sleepSeconds: t.Optional(t.Number()),
            sleep_seconds: t.Optional(t.Number()),
        }),
        parse: async ({ request, params }) => await parseAuthorizedPgmqEnqueue(request, params.ref, true),
        detail: { tags: ["tasks"], summary: "Enqueue a PGMQ message batch" },
    })
    .post("/queues/:queueName/messages/receive", async ({ params, body }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            const input = pgmqHttpReceive(body ?? {});
            const queueSettings = await projectService.getQueueSettings(params.ref, queueName);
            if (!queueSettings) {
                return status(404, { message: "Project not found", code: "404" });
            }
            const settings = pgmqHttpReceiveSettings(queueSettings);
            const messages = await pgmqService.read(
                params.ref,
                queueName,
                input.seconds ?? settings.defaultSeconds,
                pgmqInteger(input.count ?? 1, 1, settings.maxCount),
            );
            if (messages.length === 0) return status(204);
            return input.count === undefined ? messages[0] : messages;
        } catch (err: unknown) {
            if (err instanceof PgmqMutationError) return status(503, { message: "Queue receive could not be confirmed", code: "PGMQ_MUTATION_UNCONFIRMED", mutation_may_have_applied: true });
            if (err instanceof PgmqInputError) return status(400, { message: "Invalid queue input", code: "PGMQ_INPUT_INVALID" });
            return status(500, { message: "Failed to receive queue message", code: "500" });
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

            return await pgmqService.listMessages(params.ref, queueName, pgmqHttpList(query));
        } catch (err: unknown) {
            if (err instanceof PgmqInputError) return status(400, { message: "Invalid queue input", code: "PGMQ_INPUT_INVALID" });
            return status(500, { message: "Failed to list queue messages", code: "500" });
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
            if (err instanceof PgmqMutationError) return status(503, { message: "Queue pop could not be confirmed", code: "PGMQ_MUTATION_UNCONFIRMED", mutation_may_have_applied: true });
            return status(500, { message: "Failed to pop queue message", code: "500" });
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
            return status(500, { message: "Failed to retrieve queue stats", code: "500" });
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
            if (err instanceof PgmqInventoryError && err.mutationMayHaveApplied) {
                return status(503, { message: "Queue purge could not be confirmed", code: "PGMQ_MUTATION_UNCONFIRMED", mutation_may_have_applied: true });
            }
            return status(500, { message: "Failed to purge queue", code: "500" });
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
            return status(500, { message: "Failed to retrieve queue settings", code: "500" });
        }
    }, { detail: { tags: ["tasks"], summary: "Get queue settings" } })
    .patch("/queues/:queueName/settings", async ({ params, body }) => {
        try {
            const queueName = normalizeQueueName(params.queueName);
            if (!queueName) {
                return status(400, { message: "Invalid queue name", code: "400" });
            }

            const settings = await projectService.updateQueueSettings(params.ref, queueName, body);
            if (!settings) return status(404, { message: "Project not found", code: "404" });
            return settings;
        } catch (err: unknown) {
            if (err instanceof PgmqInputError) return status(400, { message: "Invalid queue settings", code: "PGMQ_INPUT_INVALID" });
            if (err instanceof PgmqSettingsConflictError) return status(409, { message: "Queue settings changed; reload before updating", code: "PGMQ_SETTINGS_CONFLICT" });
            if (err instanceof PgmqSettingsError && err.mutationMayHaveApplied) {
                return status(503, { message: "Queue settings update could not be confirmed", code: "PGMQ_MUTATION_UNCONFIRMED", mutation_may_have_applied: true });
            }
            return status(500, { message: "Failed to update queue settings", code: "500" });
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
            if (err instanceof PgmqMutationError) return status(503, { message: "Queue acknowledgement could not be confirmed", code: "PGMQ_MUTATION_UNCONFIRMED", mutation_may_have_applied: true });
            return status(500, { message: "Failed to acknowledge queue message", code: "500" });
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
            const input = body;
            const sleepSeconds = pgmqHttpDelay(input ?? {});
            const task = await pgmqService.setVisibilityTimeout(
                params.ref,
                queueName,
                messageId,
                sleepSeconds,
            );
            return task || status(404, { message: "Queue message not found", code: "404" });
        } catch (err: unknown) {
            if (err instanceof PgmqMutationError) return status(503, { message: "Queue release could not be confirmed", code: "PGMQ_MUTATION_UNCONFIRMED", mutation_may_have_applied: true });
            if (err instanceof PgmqInputError) return status(400, { message: "Invalid queue input", code: "PGMQ_INPUT_INVALID" });
            return status(500, { message: "Failed to release queue message", code: "500" });
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
            if (err instanceof PgmqMutationError) return status(503, { message: "Queue archive could not be confirmed", code: "PGMQ_MUTATION_UNCONFIRMED", mutation_may_have_applied: true });
            return status(500, { message: "Failed to fail queue message", code: "500" });
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
            if (err instanceof PgmqMutationError) return status(503, { message: "Queue message deletion could not be confirmed", code: "PGMQ_MUTATION_UNCONFIRMED", mutation_may_have_applied: true });
            return status(500, { message: "Failed to delete queue message", code: "500" });
        }
    }, { detail: { tags: ["tasks"], summary: "Delete a queue message" } })
    .get("/", async ({ params, request }) => {
        try {
            const filters = parseTaskListQuery(request);
            if (filters.taskTypes?.includes("pgflow")) {
                if (filters.taskTypes.length !== 1 || filters.functionSlug || filters.functionVersion
                    || filters.correlationId || filters.businessTaskId || filters.onlyDeadLettered) throw new InvalidTaskListQueryError();
                return await pgflowTaskService.list(params.ref, {
                    limit: filters.limit ?? 50,
                    ...(filters.statuses === undefined ? {} : { statuses: filters.statuses }),
                });
            }
            const tasks = await taskRepository.listTasksByProjectFiltered(params.ref, filters);
            return tasks;
        } catch (err: unknown) {
            if (err instanceof PgflowTaskReadError) {
                return status(503, { message: "Executor status is unavailable", code: "PGFLOW_TASKS_UNAVAILABLE" });
            }
            if (err instanceof InvalidTaskListQueryError) {
                return status(400, { message: err.message, code: "TASK_LIST_QUERY_INVALID" });
            }
                        return status(500, { message: "Failed to retrieve tasks", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, {
        query: t.Optional(t.Object({
            status: t.Optional(t.String()),
            task_type: t.Optional(t.String()),
            function_slug: t.Optional(t.String()),
            function_version: t.Optional(t.String()),
            correlation_id: t.Optional(t.String()),
            business_task_id: t.Optional(t.String()),
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
    .get("/dlq", async ({ params, request }) => {
        try {
            const tasks = await taskRepository.listTasksByProjectFiltered(params.ref, parseTaskListQuery(request, true));
            return tasks;
        } catch (err: unknown) {
            if (err instanceof InvalidTaskListQueryError) {
                return status(400, { message: err.message, code: "TASK_LIST_QUERY_INVALID" });
            }
            return status(500, { message: "Failed to retrieve DLQ tasks", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, {
        query: t.Optional(t.Object({
            summary: t.Optional(t.String()),
            correlation_id: t.Optional(t.String()),
            business_task_id: t.Optional(t.String()),
            limit: t.Optional(t.String()),
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
            const settings = await projectService.updateBackgroundTaskSettings(params.ref, body);
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
            if (isPgflowTask(params.taskId)) {
                // Native engine runs have no verified user/actor binding. Backend/admin only.
                const error = await authMiddleware.requireProjectOrAdminAuth(request, params.ref);
                if (error) return status(error.status, error.body);
                const run = await pgflowTaskService.get(params.ref, params.taskId);
                return run ?? status(404, { message: "Task not found", code: "404" });
            }
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
            if (err instanceof PgflowTaskReadError) {
                return status(503, { message: "Executor status is unavailable", code: "PGFLOW_TASKS_UNAVAILABLE" });
            }
            return status(500, { message: "Failed to retrieve task", code: "500", details: (err instanceof Error ? err.message : String(err)) });
        }
    }, { detail: { tags: ["tasks"], summary: "Get task details by ID" } })
    .post("/:taskId/cancel", async ({ params }) => {
        try {
            if (isPgflowTask(params.taskId)) {
                return status(409, { message: "Executor does not support this action", code: "TASK_ACTION_UNSUPPORTED" });
            }
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
            if (isPgflowTask(params.taskId)) {
                return status(409, { message: "Executor does not support this action", code: "TASK_ACTION_UNSUPPORTED" });
            }
            const task = await taskRepository.retryTask(params.taskId, params.ref);
            if (!task) {
                return status(404, { message: "Task not found", code: "404" });
            }
            return task;
        } catch (err: unknown) {
            return status(500, { message: "Failed to retry task", code: "500" });
        }
    }, { detail: { tags: ["tasks"], summary: "Retry a failed task" } });
