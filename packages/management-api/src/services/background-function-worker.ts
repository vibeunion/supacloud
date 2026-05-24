import type { ProjectTask } from "../db";
import { TaskStatus, TaskType } from "../db";
import { taskRepository } from "../repositories/task.repository";
import { projectRepository } from "../repositories/project.repository";
import { broadcastTaskUpdate } from "../routes/ws";
import { logger } from "../utils/logger";
import { config } from "../config";
import { DEFAULT_BACKGROUND_TASK_SETTINGS } from "../config/background-task-settings";
import { projectService } from "./project.service";
import { decryptSecretIfNeeded } from "../utils/secret-crypto";
import { createHmac } from "node:crypto";
import { getProjectDb, resolveDbName } from "../db";

interface InvocationEnvelope {
  method?: string;
  path?: string;
  query?: string;
  headers?: Record<string, string>;
  body?: string | null;
  body_encoding?: string;
  auth?: {
    kind?: "jwt" | "apikey" | "none";
    authorization?: string | null;
    apikey?: string | null;
    invoker_user_id?: string | null;
    invoker_role?: string | null;
    apikey_kind?: string | null;
  };
}

const DEFAULT_CONCURRENCY_PER_PROJECT = Number(
  process.env.BACKGROUND_TASKS_PER_PROJECT || String(DEFAULT_BACKGROUND_TASK_SETTINGS.concurrency),
);
const WORKER_ID = `bgw-${process.pid}`;

class NonRetryableBackgroundInvocationError extends Error {
  constructor(message: string, readonly responseStatus: number) {
    super(message);
    this.name = "NonRetryableBackgroundInvocationError";
  }
}

function isUuid(value: string | null | undefined): boolean {
  return !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function backgroundInvokerUserId(task: ProjectTask): string | null {
  const payload = (task.payload || {}) as InvocationEnvelope;
  const userId = payload.auth?.invoker_user_id;
  return typeof userId === "string" && userId.trim().length > 0 ? userId.trim() : null;
}

async function assertBackgroundInvokerUserExists(task: ProjectTask): Promise<void> {
  const userId = backgroundInvokerUserId(task);
  if (!userId) return;
  if (!isUuid(userId)) {
    throw new NonRetryableBackgroundInvocationError("Background invoker user id is invalid", 400);
  }

  const dbName = await resolveDbName(task.project_ref);
  const projectDb = getProjectDb(dbName);
  const rows = await projectDb`
    SELECT 1
    FROM auth.users
    WHERE id = ${userId}::uuid
    LIMIT 1
  `;
  if (rows.length === 0) {
    throw new NonRetryableBackgroundInvocationError("Background invoker user no longer exists", 410);
  }
}

function computeRetryDelayMs(attempt: number): number {
  const base = 5_000;
  const cappedAttempt = Math.min(Math.max(attempt, 1), 6);
  return base * Math.pow(2, cappedAttempt - 1);
}

function computeLeaseSeconds(timeoutSec: number | null | undefined): number {
  const timeout = timeoutSec && timeoutSec > 0 ? timeoutSec : 300;
  return Math.min(Math.max(timeout + 30, 60), 1800);
}

function scheduleLeaseHeartbeat(taskId: string, leaseSeconds: number): Timer {
  const intervalMs = Math.max(10_000, Math.floor((leaseSeconds * 1000) / 2));
  return setInterval(() => {
    void taskRepository.extendLease(taskId, leaseSeconds).catch((error: unknown) => {
      logger.warn("[BackgroundFunctionWorker] failed to extend lease", {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, intervalMs);
}

function signBackgroundInvocation(input: {
  taskId: string;
  projectRef: string;
  functionSlug: string | null;
  attempt: number;
  timestamp: string;
}): string {
  const canonical = [
    input.taskId,
    input.projectRef,
    input.functionSlug || "",
    String(input.attempt),
    input.timestamp,
  ].join("\n");
  return createHmac("sha256", config.masterToken).update(canonical).digest("hex");
}

async function importDispatcher() {
  return import("./background-runtime-dispatcher");
}

async function requestRuntimeCancellation(taskId: string): Promise<boolean> {
  try {
    const response = await fetch(`http://${config.edgeRuntimeBackgroundInternal}/internal/background/cancel/${taskId}`, {
      method: "POST",
      headers: {
        "x-supacloud-internal-auth": `Bearer ${config.masterToken}`,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const payload = await response.json().catch(() => ({ cancelled: false }));
    return !!payload.cancelled;
  } catch {
    return false;
  }
}

export function buildInvocationRequest(task: ProjectTask): Request {
  const payload = (task.payload || {}) as InvocationEnvelope;
  const headers = new Headers(payload.headers || {});
  const attempt = task.attempt || 1;
  const signatureTimestamp = new Date().toISOString();

  headers.set("x-project-ref", task.project_ref);
  headers.set("x-supacloud-task-id", task.id);
  if (task.trace_id) headers.set("x-supacloud-trace-id", task.trace_id);
  headers.set("x-supacloud-background", "true");
  headers.set("x-supacloud-attempt", String(attempt));
  headers.set("x-supacloud-function-version", task.function_version || "1");
  headers.set("x-supacloud-auth-kind", payload.auth?.kind || "none");
  if (payload.auth?.invoker_user_id) {
    headers.set("x-supacloud-invoker-user-id", payload.auth.invoker_user_id);
  }
  if (payload.auth?.invoker_role) {
    headers.set("x-supacloud-invoker-role", payload.auth.invoker_role);
  }
  if (payload.auth?.apikey_kind) {
    headers.set("x-supacloud-apikey-kind", payload.auth.apikey_kind);
  }
  if (payload.auth?.authorization) {
    headers.set("x-supacloud-auth-authorization", decryptSecretIfNeeded(payload.auth.authorization));
  }
  if (payload.auth?.apikey) {
    headers.set("x-supacloud-auth-apikey", decryptSecretIfNeeded(payload.auth.apikey));
  }
  headers.set("x-supacloud-internal-auth", `Bearer ${config.masterToken}`);
  headers.set("x-supacloud-signature-version", "v1");
  headers.set("x-supacloud-signature-timestamp", signatureTimestamp);
  headers.set("x-supacloud-signature", signBackgroundInvocation({
    taskId: task.id,
    projectRef: task.project_ref,
    functionSlug: task.function_slug,
    attempt,
    timestamp: signatureTimestamp,
  }));

  const url = new URL(
    `http://${config.edgeRuntimeBackgroundInternal}/internal/background/${task.project_ref}/${task.function_slug}${payload.path || ""}${payload.query || ""}`,
  );

  const init: RequestInit = {
    method: payload.method || "POST",
    headers,
  };

  if (payload.body && !["GET", "HEAD"].includes(init.method || "GET")) {
    init.body = payload.body;
  }

  return new Request(url.toString(), init);
}

export class BackgroundFunctionWorker {
  private isRunning = false;
  private isPolling = false;
  private intervalId?: Timer;
  private cancelledTasks = new Set<string>();

  start(intervalMs = 2_000) {
    if (this.isRunning) return;
    this.isRunning = true;
    this.intervalId = setInterval(() => void this.poll(), intervalMs);
    void this.poll();
    logger.info("[BackgroundFunctionWorker] started", {
      workerId: WORKER_ID,
      concurrencyPerProject: DEFAULT_CONCURRENCY_PER_PROJECT,
    });
  }

  stop() {
    this.isRunning = false;
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = undefined;
  }

  private async poll() {
    if (!this.isRunning || this.isPolling) return;
    this.isPolling = true;

    try {
      while (this.isRunning) {
        const task = await taskRepository.claimNextTask({
          workerId: WORKER_ID,
          allowedTaskTypes: [TaskType.EDGE_FUNCTION],
          leaseSeconds: 900,
        });
        if (!task) break;

        const project = await projectRepository.findByRef(task.project_ref);
        if (!project || project.status !== "active") {
          await taskRepository.cancelTask(task.id, !project ? "Project not found" : `Project is ${project.status}`);
          continue;
        }

        void this.execute(task).catch((error: unknown) => {
          logger.error("[BackgroundFunctionWorker] unhandled task execution failure", {
            taskId: task.id,
            projectRef: task.project_ref,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } catch (error: unknown) {
      logger.error("[BackgroundFunctionWorker] poll failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.isPolling = false;
    }
  }

  private async execute(task: ProjectTask) {
    const project = await projectRepository.findByRef(task.project_ref);
    if (!project || project.status !== "active") {
      await taskRepository.cancelTask(task.id, !project ? "Project not found" : `Project is ${project.status}`);
      broadcastTaskUpdate({
        taskId: task.id,
        projectRef: task.project_ref,
        taskType: task.task_type,
        status: TaskStatus.CANCELLED,
        error: !project ? "Project not found" : `Project is ${project.status}`,
      });
      return;
    }

    const leaseSeconds = computeLeaseSeconds(task.timeout_sec);
    const lease = await taskRepository.extendLease(task.id, leaseSeconds);
    if (!lease) {
      broadcastTaskUpdate({
        taskId: task.id,
        projectRef: task.project_ref,
        taskType: task.task_type,
        status: TaskStatus.CANCELLED,
        error: task.cancellation_reason || "Cancelled before execution",
      });
      return;
    }
    await taskRepository.markTaskRunning(task.id);
    await taskRepository.startTaskAttempt(task);
    broadcastTaskUpdate({
      taskId: task.id,
      projectRef: task.project_ref,
      taskType: task.task_type,
      status: TaskStatus.RUNNING,
    });

    const heartbeat = scheduleLeaseHeartbeat(task.id, leaseSeconds);
    const startedAt = Date.now();
    const logs: Array<{
      timestamp: string;
      stream: "stdout" | "stderr";
      level: string;
      message: string;
    }> = [];

    try {
      await assertBackgroundInvokerUserExists(task);
      const request = buildInvocationRequest(task);
      const { dispatchBackgroundFunction } = await importDispatcher();
      const response = await dispatchBackgroundFunction({
        projectRef: task.project_ref,
        functionSlug: task.function_slug || "",
        request,
        onLog: (entry) => {
          logs.push(entry);
          if (logs.length > 200) logs.shift();
        },
      });

      const result = {
        status: response.status,
        headers: response.headers,
        body: response.bodyText.slice(0, 16_384),
      };

      if (response.status === 499 || this.cancelledTasks.has(task.id)) {
        clearInterval(heartbeat);
        this.cancelledTasks.delete(task.id);
        await taskRepository.completeTaskAttempt(task.id, task.attempt || 1, {
          status: "cancelled",
          error: task.cancellation_reason || "Cancelled by user",
          responseStatus: response.status,
          durationMs: Date.now() - startedAt,
          logs,
        });
        await taskRepository.cancelTask(task.id, task.cancellation_reason || "Cancelled by user");
        broadcastTaskUpdate({
          taskId: task.id,
          projectRef: task.project_ref,
          taskType: task.task_type,
          status: TaskStatus.CANCELLED,
          error: task.cancellation_reason || "Cancelled by user",
        });
        return;
      }

      if (response.status >= 200 && response.status < 300) {
        clearInterval(heartbeat);
        await taskRepository.completeTaskAttempt(task.id, task.attempt || 1, {
          status: "succeeded",
          responseStatus: response.status,
          durationMs: Date.now() - startedAt,
          logs,
        });
        await taskRepository.markTaskSucceeded(task.id, result);
        broadcastTaskUpdate({
          taskId: task.id,
          projectRef: task.project_ref,
          taskType: task.task_type,
          status: TaskStatus.SUCCEEDED,
        });
        return;
      }

      throw new Error(`Background function returned HTTP ${response.status}`);
    } catch (error: unknown) {
      clearInterval(heartbeat);
      const message = error instanceof Error ? error.message : String(error);
      const attempt = task.attempt || 1;
      const maxAttempts = task.max_attempts || 3;
      const responseStatusMatch = message.match(/HTTP (\d+)/i);
      const responseStatus = responseStatusMatch ? Number.parseInt(responseStatusMatch[1], 10) : null;

      if (error instanceof NonRetryableBackgroundInvocationError) {
        await taskRepository.completeTaskAttempt(task.id, attempt, {
          status: "dead_lettered",
          error: message,
          responseStatus: error.responseStatus,
          durationMs: Date.now() - startedAt,
          logs,
        });
        await taskRepository.markTaskFailed(task.id, message, true);
        broadcastTaskUpdate({
          taskId: task.id,
          projectRef: task.project_ref,
          taskType: task.task_type,
          status: TaskStatus.DEAD_LETTERED,
          error: message,
        });
        return;
      }

      if (attempt < maxAttempts) {
        await taskRepository.completeTaskAttempt(task.id, attempt, {
          status: "retry_scheduled",
          error: message,
          responseStatus,
          durationMs: Date.now() - startedAt,
          logs,
        });
        const nextRunAt = new Date(Date.now() + computeRetryDelayMs(attempt));
        await taskRepository.scheduleRetry(task.id, message, nextRunAt);
        broadcastTaskUpdate({
          taskId: task.id,
          projectRef: task.project_ref,
          taskType: task.task_type,
          status: TaskStatus.RETRY_SCHEDULED,
          error: message,
        });
      } else {
        await taskRepository.completeTaskAttempt(task.id, attempt, {
          status: "dead_lettered",
          error: message,
          responseStatus,
          durationMs: Date.now() - startedAt,
          logs,
        });
        await taskRepository.markTaskFailed(task.id, message, true);
        broadcastTaskUpdate({
          taskId: task.id,
          projectRef: task.project_ref,
          taskType: task.task_type,
          status: TaskStatus.DEAD_LETTERED,
          error: message,
        });
      }

      logger.error("[BackgroundFunctionWorker] task failed", {
        taskId: task.id,
        projectRef: task.project_ref,
        attempt,
        maxAttempts,
        error: message,
      });
    }
  }

  async cancel(taskId: string): Promise<boolean> {
    const task = await taskRepository.getTaskById(taskId);
    if (!task) return false;

    await taskRepository.requestTaskCancellation(taskId, "Cancelled by user");
    this.cancelledTasks.add(taskId);

    if (task.status === TaskStatus.PENDING || task.status === TaskStatus.RETRY_SCHEDULED) {
      await taskRepository.cancelTask(taskId, "Cancelled by user");
      return true;
    }

    const cancelled = await requestRuntimeCancellation(taskId);
    if (!cancelled) {
      this.cancelledTasks.delete(taskId);
    }
    return cancelled;
  }
}

export const backgroundFunctionWorker = new BackgroundFunctionWorker();
