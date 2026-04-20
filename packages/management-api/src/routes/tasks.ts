import { Elysia, status, t } from "elysia";
import { taskRepository } from "../repositories/task.repository";
import { TaskStatus } from "../db";
import { backgroundFunctionWorker, projectService } from "../services";

export const taskRoutes = new Elysia({ prefix: "/v1/projects/:ref/tasks" })
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
