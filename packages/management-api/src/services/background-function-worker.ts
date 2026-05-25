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
import { createBackgroundTaskMirrorIfUserExists } from "../services/background-task.service";
import { createPgListener, type PgListenerHandle } from "../lib/pg-listen";

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

// ─── Invoker existence cache + in-flight coalescing ─────────────────────
interface InvokerCacheEntry {
  exists: boolean;
  expiresAt: number;
}

const invokerCache = new Map<string, InvokerCacheEntry>();
const INVOKER_POSITIVE_TTL = 15_000;  // 用户存在时缓存 15s
const INVOKER_NEGATIVE_TTL = 2_000;   // 用户不存在时缓存 2s（快速重试）

const invokerInflight = new Map<string, Promise<boolean>>();

// ─── Invoker DB unknown (degraded) tracking + circuit breaker ──────────────
const INVOKER_UNKNOWN_WINDOW_MS = 60_000;   // 1-minute sliding window
const INVOKER_UNKNOWN_THRESHOLD = 10;       // 10 unknowns in window → circuit open
const INVOKER_CIRCUIT_OPEN_DURATION_MS = 30_000; // 30s cooldown when circuit is open

interface UnknownEvent {
  timestamp: number;
  projectRef: string;
  error: string;
}

const invokerUnknownEvents: UnknownEvent[] = [];
let invokerCircuitOpenUntil = 0;  // 0 = circuit closed

function recordInvokerUnknown(projectRef: string, error: string): void {
  const now = Date.now();
  invokerUnknownEvents.push({ timestamp: now, projectRef, error });

  // Prune events outside the sliding window
  const cutoff = now - INVOKER_UNKNOWN_WINDOW_MS;
  while (invokerUnknownEvents.length > 0 && invokerUnknownEvents[0].timestamp < cutoff) {
    invokerUnknownEvents.shift();
  }

  logger.warn("[BackgroundFunctionWorker] invoker DB unknown (degraded)", {
    projectRef,
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

  const cacheKey = `${task.project_ref}:${userId}`;

  // 检查缓存
  const cached = invokerCache.get(cacheKey);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      if (!cached.exists) {
        throw new NonRetryableBackgroundInvocationError("Background invoker user no longer exists", 410);
      }
      return;
    }
    // 过期条目清除
    invokerCache.delete(cacheKey);
  }

  // In-flight coalescing: 同一用户的并发校验共用一个 Promise
  const inflight = invokerInflight.get(cacheKey);
  if (inflight) {
    const exists = await inflight;
    if (!exists) {
      throw new NonRetryableBackgroundInvocationError("Background invoker user no longer exists", 410);
    }
    return;
  }

  const promise = _checkInvokerExists(task.project_ref, userId);
  invokerInflight.set(cacheKey, promise);

  try {
    const exists = await promise;
    if (!exists) {
      throw new NonRetryableBackgroundInvocationError("Background invoker user no longer exists", 410);
    }
  } finally {
    invokerInflight.delete(cacheKey);
  }
}

async function _checkInvokerExists(projectRef: string, userId: string): Promise<boolean> {
  const cacheKey = `${projectRef}:${userId}`;

  // Circuit breaker: if DB is down system-wide, skip checks and fail-open
  if (isInvokerCircuitOpen()) {
    recordInvokerUnknown(projectRef, "circuit_breaker_open");
    // Fail-open during circuit: assume user exists to avoid mass dead-lettering
    return true;
  }

  try {
    const dbName = await resolveDbName(projectRef);
    const projectDb = getProjectDb(dbName);
    const rows = await projectDb`
      SELECT 1
      FROM auth.users
      WHERE id = ${userId}::uuid
        AND deleted_at IS NULL
      LIMIT 1
    `;
    const exists = rows.length > 0;

    invokerCache.set(cacheKey, {
      exists,
      expiresAt: Date.now() + (exists ? INVOKER_POSITIVE_TTL : INVOKER_NEGATIVE_TTL),
    });

    return exists;
  } catch (error: unknown) {
    // DB 查询失败 → record as unknown for circuit breaker tracking
    const errMsg = error instanceof Error ? error.message : String(error);
    recordInvokerUnknown(projectRef, errMsg);

    // Short-term fail-open: assume user exists to avoid mass dead-lettering
    // during transient DB failures. Long-term protection via circuit breaker.
    return true;
  }
}

function invalidateInvokerCache(projectRef: string, userId?: string): void {
  if (userId) {
    invokerCache.delete(`${projectRef}:${userId}`);
    invokerInflight.delete(`${projectRef}:${userId}`);
  } else {
    for (const key of invokerCache.keys()) {
      if (key.startsWith(`${projectRef}:`)) {
        invokerCache.delete(key);
      }
    }
    for (const key of invokerInflight.keys()) {
      if (key.startsWith(`${projectRef}:`)) {
        invokerInflight.delete(key);
      }
    }
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

    // extendLease 确认租约，然后并行：状态转换 + invoker 校验 + mirror insert
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

    // 并行执行：transitionTaskToRunning（合并 markRunning + startAttempt）+ invoker 校验 + mirror
    const [, invokerError, mirrorResult] = await Promise.all([
      taskRepository.transitionTaskToRunning(task.id, task, leaseSeconds),
      assertBackgroundInvokerUserExists(task).then(() => null, (e: unknown) => e),
      createBackgroundTaskMirrorIfUserExists(task),
    ]);

    broadcastTaskUpdate({
      taskId: task.id,
      projectRef: task.project_ref,
      taskType: task.task_type,
      status: TaskStatus.RUNNING,
    });

    // invoker 校验失败 → dead-letter
    if (invokerError instanceof NonRetryableBackgroundInvocationError) {
      const heartbeat = scheduleLeaseHeartbeat(task.id, leaseSeconds);
      clearInterval(heartbeat);
      await taskRepository.completeTaskAttempt(task.id, task.attempt || 1, {
        status: "dead_lettered",
        error: invokerError.message,
        responseStatus: invokerError.responseStatus,
        durationMs: 0,
        logs: [],
      });
      await taskRepository.markTaskFailed(task.id, invokerError.message, true);
      broadcastTaskUpdate({
        taskId: task.id,
        projectRef: task.project_ref,
        taskType: task.task_type,
        status: TaskStatus.DEAD_LETTERED,
        error: invokerError.message,
      });
      return;
    }

    // mirror degraded: log warning but continue
    if (mirrorResult?.degraded) {
      logger.warn("[BackgroundFunctionWorker] mirror check degraded, continuing without mirror", {
        taskId: task.id,
        projectRef: task.project_ref,
      });
    }

    // mirror RPC 确认用户不存在 → dead-letter
    if (mirrorResult && !mirrorResult.userExists) {
      const heartbeat = scheduleLeaseHeartbeat(task.id, leaseSeconds);
      clearInterval(heartbeat);
      await taskRepository.completeTaskAttempt(task.id, task.attempt || 1, {
        status: "dead_lettered",
        error: "Background invoker user no longer exists (atomic RPC check)",
        responseStatus: 410,
        durationMs: 0,
        logs: [],
      });
      await taskRepository.markTaskFailed(task.id, "Background invoker user no longer exists (atomic RPC check)", true);
      broadcastTaskUpdate({
        taskId: task.id,
        projectRef: task.project_ref,
        taskType: task.task_type,
        status: TaskStatus.DEAD_LETTERED,
        error: "Background invoker user no longer exists (atomic RPC check)",
      });
      return;
    }

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

export { invalidateInvokerCache, getInvokerUnknownMetrics };
export const backgroundFunctionWorker = new BackgroundFunctionWorker();
