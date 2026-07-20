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
import { availableParallelism } from "node:os";
import { getProjectDb, resolveDbName } from "../db";
import {
  createBackgroundTaskMirrorIfUserExists,
  removeBackgroundTaskMirror,
} from "../services/background-task.service";
import { createPgListener, type PgListenerHandle } from "../lib/pg-listen";
import {
  normalizedGoTrueUserId,
} from "../utils/project-user-lifecycle";
import { getAuthRuntimeDescriptor } from "./auth-runtime.service";

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

export function resolveBackgroundConcurrencyPerProject(value?: string): number {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(DEFAULT_BACKGROUND_TASK_SETTINGS.concurrency, parsed);
  }

  const cpuScaledLimit = Math.max(2, availableParallelism() * 4);
  return Math.min(DEFAULT_BACKGROUND_TASK_SETTINGS.concurrency, cpuScaledLimit);
}

const DEFAULT_CONCURRENCY_PER_PROJECT = resolveBackgroundConcurrencyPerProject(
  process.env.BACKGROUND_TASKS_PER_PROJECT,
);
const WORKER_ID = `bgw-${process.pid}`;

// ─── Invoker DB unknown (degraded) tracking + circuit breaker ──────────────
const INVOKER_UNKNOWN_WINDOW_MS = 60_000;   // 1-minute sliding window
const INVOKER_UNKNOWN_THRESHOLD = 10;       // 10 unknowns in window → circuit open
const INVOKER_CIRCUIT_OPEN_DURATION_MS = 30_000; // 30s cooldown when circuit is open

interface UnknownEvent {
  timestamp: number;
  projectRef: string;
  authorityProjectRef: string;
  error: string;
}

const invokerUnknownEvents: UnknownEvent[] = [];
let invokerCircuitOpenUntil = 0;  // 0 = circuit closed

function recordInvokerUnknown(projectRef: string, authorityProjectRef: string, error: string): void {
  const now = Date.now();
  invokerUnknownEvents.push({ timestamp: now, projectRef, authorityProjectRef, error });

  // Prune events outside the sliding window
  const cutoff = now - INVOKER_UNKNOWN_WINDOW_MS;
  while (invokerUnknownEvents.length > 0 && invokerUnknownEvents[0].timestamp < cutoff) {
    invokerUnknownEvents.shift();
  }

  logger.warn("[BackgroundFunctionWorker] invoker DB unknown (degraded)", {
    projectRef,
    authorityProjectRef,
    error,
    windowCount: invokerUnknownEvents.length,
    threshold: INVOKER_UNKNOWN_THRESHOLD,
  });

  // Open circuit breaker if threshold exceeded
  if (invokerUnknownEvents.length >= INVOKER_UNKNOWN_THRESHOLD && invokerCircuitOpenUntil < now) {
    invokerCircuitOpenUntil = now + INVOKER_CIRCUIT_OPEN_DURATION_MS;
    logger.error("[BackgroundFunctionWorker] invoker DB circuit breaker OPENED", {
      windowCount: invokerUnknownEvents.length,
      cooldownMs: INVOKER_CIRCUIT_OPEN_DURATION_MS,
    });
  }
}

function isInvokerCircuitOpen(): boolean {
  return Date.now() < invokerCircuitOpenUntil;
}

function getInvokerUnknownMetrics(): {
  unknown_window_count: number;
  circuit_open: boolean;
  circuit_open_until: number;
} {
  const now = Date.now();
  const cutoff = now - INVOKER_UNKNOWN_WINDOW_MS;
  const recentCount = invokerUnknownEvents.filter(e => e.timestamp >= cutoff).length;
  return {
    unknown_window_count: recentCount,
    circuit_open: isInvokerCircuitOpen(),
    circuit_open_until: invokerCircuitOpenUntil,
  };
}

class NonRetryableBackgroundInvocationError extends Error {
  constructor(message: string, readonly responseStatus: number) {
    super(message);
    this.name = "NonRetryableBackgroundInvocationError";
  }
}

class RetryableBackgroundInvocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableBackgroundInvocationError";
  }
}

function backgroundInvokerUserId(task: ProjectTask): string | null {
  const payload = (task.payload || {}) as InvocationEnvelope;
  const payloadUserId = payload.auth?.invoker_user_id;
  const authoritativeUserId = task.invoker_user_id;
  if (authoritativeUserId) {
    if (typeof payloadUserId !== "string") {
      throw new NonRetryableBackgroundInvocationError("Background task invoker identity is inconsistent", 422);
    }
    const normalizedPayloadUserId = normalizedGoTrueUserId(payloadUserId);
    if (normalizedPayloadUserId !== normalizedGoTrueUserId(authoritativeUserId)) {
      throw new NonRetryableBackgroundInvocationError("Background task invoker identity is inconsistent", 422);
    }
    return authoritativeUserId;
  }
  if (payloadUserId === undefined || payloadUserId === null) return null;
  if (typeof payloadUserId !== "string") {
    throw new NonRetryableBackgroundInvocationError("Background task invoker identity is inconsistent", 422);
  }
  return payloadUserId.trim() || null;
}

function backgroundAuthAuthorityRef(task: ProjectTask): string {
  const configuredAuthorityRef = getAuthRuntimeDescriptor(task.project_ref).authority_project_ref;
  const storedAuthorityRef = task.auth_authority_ref;
  if (storedAuthorityRef && storedAuthorityRef !== configuredAuthorityRef) {
    throw new NonRetryableBackgroundInvocationError("Background task auth authority is inconsistent", 422);
  }
  return storedAuthorityRef || configuredAuthorityRef;
}

async function assertBackgroundInvokerUserExists(task: ProjectTask): Promise<void> {
  const userId = backgroundInvokerUserId(task);
  if (!userId) return;
  const normalizedUserId = normalizedGoTrueUserId(userId);
  if (!normalizedUserId) {
    throw new NonRetryableBackgroundInvocationError("Background invoker user id is invalid", 400);
  }

  const authorityProjectRef = backgroundAuthAuthorityRef(task);
  const exists = await checkInvokerExists(task.project_ref, authorityProjectRef, normalizedUserId);
  if (!exists) {
    throw new NonRetryableBackgroundInvocationError("Background invoker user no longer exists", 410);
  }
}

async function checkInvokerExists(
  projectRef: string,
  authorityProjectRef: string,
  userId: string,
): Promise<boolean> {
  if (isInvokerCircuitOpen()) {
    recordInvokerUnknown(projectRef, authorityProjectRef, "circuit_breaker_open");
    throw new RetryableBackgroundInvocationError("Background invoker state is unavailable while the safety circuit is open");
  }

  try {
    const dbName = await resolveDbName(authorityProjectRef);
    const projectDb = getProjectDb(dbName);
    const rows = await projectDb`
      SELECT 1
      FROM auth.users
      WHERE id = ${userId}::uuid
        AND deleted_at IS NULL
      LIMIT 1
    `;
    return rows.length > 0;
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    recordInvokerUnknown(projectRef, authorityProjectRef, errMsg);
    throw new RetryableBackgroundInvocationError(`Background invoker state is unavailable: ${errMsg}`);
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

function isUserDeletionFenceError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("USER_DELETION_FENCED");
}

async function cleanupBackgroundTaskMirrorEvidence(task: ProjectTask): Promise<void> {
  if (await removeBackgroundTaskMirror(task)) return;
  logger.error("[BackgroundFunctionWorker] terminal mirror evidence cleanup remains pending", {
    taskId: task.id,
    projectRef: task.project_ref,
  });
}

function preflightFailure(task: ProjectTask, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const attempt = task.attempt || 1;
  const maxAttempts = task.max_attempts || 3;
  const nonRetryable = error instanceof NonRetryableBackgroundInvocationError
    || isUserDeletionFenceError(error);
  return {
    message,
    attempt,
    deadLetter: nonRetryable || attempt >= maxAttempts,
    responseStatus: error instanceof NonRetryableBackgroundInvocationError
      ? error.responseStatus
      : null,
  };
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
  private delayedWakeupId?: Timer;
  private listener?: PgListenerHandle;
  private pendingPoll = false;
  private cancelledTasks = new Set<string>();

  start(intervalMs = 10_000) {
    if (this.isRunning) return;
    this.isRunning = true;
    this.startListener();
    this.intervalId = setInterval(() => void this.poll(), intervalMs);
    void this.poll();
    logger.info("[BackgroundFunctionWorker] started", {
      workerId: WORKER_ID,
      concurrencyPerProject: DEFAULT_CONCURRENCY_PER_PROJECT,
      pollingFallbackMs: intervalMs,
    });
  }

  stop() {
    this.isRunning = false;
    this.listener?.close();
    this.listener = undefined;
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = undefined;
    if (this.delayedWakeupId) clearTimeout(this.delayedWakeupId);
    this.delayedWakeupId = undefined;
    this.pendingPoll = false;
  }

  private startListener() {
    try {
      this.listener = createPgListener({
        url: config.databaseUrl,
        channels: ["task_pending", "task_retry_scheduled"],
        applicationName: "supacloud-background-function-worker",
        onNotification: (channel, payload) => {
          if (!this.isEdgeFunctionNotification(payload)) return;
          if (channel === "task_retry_scheduled") {
            this.scheduleDelayedWakeup(payload);
            return;
          }
          this.wake();
        },
      });
    } catch (error: unknown) {
      logger.warn("[BackgroundFunctionWorker] failed to start pg-listen, using fallback polling", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private isEdgeFunctionNotification(payload?: string): boolean {
    if (!payload) return false;
    try {
      const parsed = JSON.parse(payload) as { task_type?: unknown };
      return parsed.task_type === TaskType.EDGE_FUNCTION;
    } catch {
      return false;
    }
  }

  private extractNextRunAt(payload?: string): Date | null {
    if (!payload) return null;
    try {
      const parsed = JSON.parse(payload) as { next_run_at?: unknown };
      if (typeof parsed.next_run_at !== "string") return null;
      const nextRunAt = new Date(parsed.next_run_at);
      return Number.isNaN(nextRunAt.getTime()) ? null : nextRunAt;
    } catch {
      return null;
    }
  }

  private scheduleDelayedWakeup(payload?: string) {
    if (!this.isRunning) return;
    const nextRunAt = this.extractNextRunAt(payload);
    if (!nextRunAt) return;
    const delayMs = Math.max(0, nextRunAt.getTime() - Date.now());
    if (this.delayedWakeupId) clearTimeout(this.delayedWakeupId);
    this.delayedWakeupId = setTimeout(() => {
      this.delayedWakeupId = undefined;
      this.wake();
    }, delayMs);
  }

  private wake() {
    if (!this.isRunning) return;
    if (this.isPolling) {
      this.pendingPoll = true;
      return;
    }
    void this.poll();
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
          concurrencyByProject: DEFAULT_CONCURRENCY_PER_PROJECT,
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
      if (this.pendingPoll && this.isRunning) {
        this.pendingPoll = false;
        queueMicrotask(() => this.wake());
      }
    }
  }

  private async finishPreflightFailure(task: ProjectTask, error: unknown): Promise<void> {
    const failure = preflightFailure(task, error);
    await taskRepository.startTaskAttempt(task);
    await taskRepository.completeTaskAttempt(task.id, failure.attempt, {
      status: failure.deadLetter ? "dead_lettered" : "retry_scheduled",
      error: failure.message,
      responseStatus: failure.responseStatus,
      durationMs: 0,
      logs: [],
    });

    if (failure.deadLetter) {
      await taskRepository.markTaskFailed(task.id, failure.message, true);
    } else {
      const nextRunAt = new Date(Date.now() + computeRetryDelayMs(failure.attempt));
      await taskRepository.scheduleRetry(task.id, failure.message, nextRunAt);
    }

    broadcastTaskUpdate({
      taskId: task.id,
      projectRef: task.project_ref,
      taskType: task.task_type,
      status: failure.deadLetter ? TaskStatus.DEAD_LETTERED : TaskStatus.RETRY_SCHEDULED,
      error: failure.message,
    });
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

    try {
      await assertBackgroundInvokerUserExists(task);
    } catch (error) {
      await this.finishPreflightFailure(task, error);
      return;
    }

    const mirrorResult = await createBackgroundTaskMirrorIfUserExists(task);
    if (mirrorResult.degraded) {
      logger.warn("[BackgroundFunctionWorker] mirror check degraded", {
        taskId: task.id,
        projectRef: task.project_ref,
      });
    }

    try {
      const transition = await taskRepository.transitionTaskToRunning(task.id, task, leaseSeconds);
      if (!transition.task) {
        throw new RetryableBackgroundInvocationError(
          "Background task could not transition to running; invocation was not dispatched",
        );
      }
    } catch (error) {
      await this.finishPreflightFailure(task, error);
      await cleanupBackgroundTaskMirrorEvidence(task);
      return;
    }

    // mirror 只保留证据；dispatch 前必须绕过任何正向共享缓存，直读 GoTrue。
    try {
      await assertBackgroundInvokerUserExists(task);
    } catch (error) {
      await this.finishPreflightFailure(task, error);
      await cleanupBackgroundTaskMirrorEvidence(task);
      return;
    }

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
    } finally {
      await cleanupBackgroundTaskMirrorEvidence(task);
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

export { getInvokerUnknownMetrics };
export const backgroundFunctionWorker = new BackgroundFunctionWorker();
