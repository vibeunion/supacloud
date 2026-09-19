import type { ProjectTask } from "../db";
import { TaskStatus, TaskType } from "../db";
import { taskRepository } from "../repositories/task.repository";
import { projectRepository } from "../repositories/project.repository";
import { broadcastTaskUpdate } from "../routes/ws";
import { logger } from "../utils/logger";
import { config } from "../config";
import { DEFAULT_BACKGROUND_TASK_SETTINGS } from "../config/background-task-settings";
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
import { parseTaskTraceparent, taskAttemptTrace } from "../utils/task-trace";
import { recordBackgroundObservation } from "../utils/background-observability";
import { backgroundAttemptStore } from "./background-attempt.service";
import type { BackgroundAttemptCompletion } from "../repositories/background-attempt-store";
import { startBackgroundLeaseHeartbeat } from "../utils/background-lease-heartbeat";

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
const INVOKER_UNKNOWN_WINDOW_MS = 60_000;
const INVOKER_UNKNOWN_THRESHOLD = 10;
const INVOKER_CIRCUIT_OPEN_DURATION_MS = 30_000;

interface UnknownEvent {
  timestamp: number;
  projectRef: string;
  authorityProjectRef: string;
  error: string;
}

const invokerUnknownEvents: UnknownEvent[] = [];
let invokerCircuitOpenUntil = 0;

function recordInvokerUnknown(projectRef: string, authorityProjectRef: string, error: string): void {
  const now = Date.now();
  invokerUnknownEvents.push({ timestamp: now, projectRef, authorityProjectRef, error });
  const cutoff = now - INVOKER_UNKNOWN_WINDOW_MS;
  while (invokerUnknownEvents.length > 0 && invokerUnknownEvents[0].timestamp < cutoff) {
    invokerUnknownEvents.shift();
  }
  logger.warn("[BackgroundFunctionWorker] invoker DB unknown (degraded)", {
    projectRef, authorityProjectRef, error,
    windowCount: invokerUnknownEvents.length,
    threshold: INVOKER_UNKNOWN_THRESHOLD,
  });
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

async function checkInvokerExists(projectRef: string, authorityProjectRef: string, userId: string): Promise<boolean> {
  if (isInvokerCircuitOpen()) {
    recordInvokerUnknown(projectRef, authorityProjectRef, "circuit_breaker_open");
    throw new RetryableBackgroundInvocationError("Background invoker state is unavailable while the safety circuit is open");
  }
  try {
    const dbName = await resolveDbName(authorityProjectRef);
    const projectDb = getProjectDb(dbName);
    const rows = await projectDb`
      SELECT 1 FROM auth.users WHERE id = ${userId}::uuid AND deleted_at IS NULL LIMIT 1
    `;
    return rows.length > 0;
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    recordInvokerUnknown(projectRef, authorityProjectRef, errMsg);
    throw new RetryableBackgroundInvocationError(`Background invoker state is unavailable: ${errMsg}`);
  }
}

export function computeRetryDelayMs(attempt: number): number {
  const base = 5_000;
  const cappedAttempt = Math.min(Math.max(attempt, 1), 6);
  return base * Math.pow(2, cappedAttempt - 1);
}

export function computeLeaseSeconds(timeoutSec: number | null | undefined): number {
  const timeout = timeoutSec && timeoutSec > 0 ? timeoutSec : 300;
  return Math.min(Math.max(timeout + 30, 60), 1800);
}

function isUserDeletionFenceError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("USER_DELETION_FENCED");
}

async function cleanupBackgroundTaskMirrorEvidence(task: ProjectTask): Promise<void> {
  if (await removeBackgroundTaskMirror(task)) return;
  logger.error("[BackgroundFunctionWorker] terminal mirror evidence cleanup remains pending", {
    taskId: task.id, projectRef: task.project_ref,
  });
}

function failureOutcome(task: ProjectTask, error: unknown, durationMs = 0): BackgroundAttemptCompletion {
  const message = error instanceof Error ? error.message : String(error);
  const attempt = task.attempt || 1;
  const nonRetryable = error instanceof NonRetryableBackgroundInvocationError || isUserDeletionFenceError(error);
  const deadLetter = nonRetryable || attempt >= (task.max_attempts || 3);
  const responseStatusMatch = message.match(/HTTP (\d+)/i);
  return {
    status: deadLetter ? "dead_lettered" : "retry_scheduled",
    error: message,
    responseStatus: error instanceof NonRetryableBackgroundInvocationError
      ? error.responseStatus : responseStatusMatch ? Number.parseInt(responseStatusMatch[1], 10) : null,
    durationMs,
    ...(deadLetter ? {} : { nextRunAt: new Date(Date.now() + computeRetryDelayMs(attempt)) }),
  };
}

function signBackgroundInvocation(input: {
  taskId: string; projectRef: string; functionSlug: string | null; attempt: number; timestamp: string;
}): string {
  const canonical = [input.taskId, input.projectRef, input.functionSlug || "", String(input.attempt), input.timestamp].join("\n");
  return createHmac("sha256", config.masterToken).update(canonical).digest("hex");
}

async function importDispatcher() {
  return import("./background-runtime-dispatcher");
}

// Retained only for legacy non-edge task cancellation. Edge invocations use their
// own request AbortSignal, never a task-ID-only RPC that could hit a newer attempt.
async function requestRuntimeCancellation(taskId: string): Promise<boolean> {
  try {
    const response = await fetch(`http://${config.edgeRuntimeBackgroundInternal}/internal/background/cancel/${taskId}`, {
      method: "POST",
      headers: { "x-supacloud-internal-auth": `Bearer ${config.masterToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const payload = await response.json().catch(() => ({ cancelled: false }));
    return !!payload.cancelled;
  } catch { return false; }
}

export function buildInvocationRequest(task: ProjectTask, signal?: AbortSignal): Request {
  const payload = (task.payload || {}) as InvocationEnvelope;
  const headers = new Headers(payload.headers || {});
  const attempt = task.attempt || 1;
  const signatureTimestamp = new Date().toISOString();
  headers.set("x-project-ref", task.project_ref);
  headers.set("x-supacloud-task-id", task.id);
  try {
    const trace = taskAttemptTrace(task);
    trace.forEach((value, name) => headers.set(name, value));
  } catch {
    throw new NonRetryableBackgroundInvocationError("Background trace identity is inconsistent", 422);
  }
  headers.delete("tracestate");
  headers.delete("baggage");
  headers.set("x-supacloud-background", "true");
  headers.set("x-supacloud-attempt", String(attempt));
  headers.set("x-supacloud-function-version", task.function_version || "1");
  headers.set("x-supacloud-auth-kind", payload.auth?.kind || "none");
  if (payload.auth?.invoker_user_id) headers.set("x-supacloud-invoker-user-id", payload.auth.invoker_user_id);
  if (payload.auth?.invoker_role) headers.set("x-supacloud-invoker-role", payload.auth.invoker_role);
  if (payload.auth?.apikey_kind) headers.set("x-supacloud-apikey-kind", payload.auth.apikey_kind);
  if (payload.auth?.authorization) {
    headers.set("x-supacloud-auth-authorization", decryptSecretIfNeeded(payload.auth.authorization));
  }
  if (payload.auth?.apikey) headers.set("x-supacloud-auth-apikey", decryptSecretIfNeeded(payload.auth.apikey));
  headers.set("x-supacloud-internal-auth", `Bearer ${config.masterToken}`);
  headers.set("x-supacloud-signature-version", "v1");
  headers.set("x-supacloud-signature-timestamp", signatureTimestamp);
  headers.set("x-supacloud-signature", signBackgroundInvocation({
    taskId: task.id, projectRef: task.project_ref, functionSlug: task.function_slug, attempt, timestamp: signatureTimestamp,
  }));
  const url = new URL(
    `http://${config.edgeRuntimeBackgroundInternal}/internal/background/${task.project_ref}/${task.function_slug}${payload.path || ""}${payload.query || ""}`,
  );
  const init: RequestInit = { method: payload.method || "POST", headers, signal };
  if (payload.body && !["GET", "HEAD"].includes(init.method || "GET")) init.body = payload.body;
  return new Request(url.toString(), init);
}

export class BackgroundFunctionWorker {
  private isRunning = false;
  private isPolling = false;
  private intervalId?: Timer;
  private delayedWakeupId?: Timer;
  private listener?: PgListenerHandle;
  private pendingPoll = false;
  private activeAttempts = new Map<string, { attempt: number; controller: AbortController }>();

  start(intervalMs = 10_000) {
    if (this.isRunning) return;
    this.isRunning = true;
    this.startListener();
    this.intervalId = setInterval(() => void this.poll(), intervalMs);
    void this.poll();
    logger.info("[BackgroundFunctionWorker] started", {
      workerId: WORKER_ID, concurrencyPerProject: DEFAULT_CONCURRENCY_PER_PROJECT, pollingFallbackMs: intervalMs,
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
    try { return (JSON.parse(payload) as { task_type?: unknown }).task_type === TaskType.EDGE_FUNCTION; }
    catch { return false; }
  }

  private extractNextRunAt(payload?: string): Date | null {
    if (!payload) return null;
    try {
      const parsed = JSON.parse(payload) as { next_run_at?: unknown };
      if (typeof parsed.next_run_at !== "string") return null;
      const nextRunAt = new Date(parsed.next_run_at);
      return Number.isNaN(nextRunAt.getTime()) ? null : nextRunAt;
    } catch { return null; }
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
    if (this.isPolling) { this.pendingPoll = true; return; }
    void this.poll();
  }

  private async poll() {
    if (!this.isRunning || this.isPolling) return;
    this.isPolling = true;
    try {
      await backgroundAttemptStore.recoverCancelled();
      while (this.isRunning) {
        const task = await taskRepository.claimNextTask({
          workerId: WORKER_ID, allowedTaskTypes: [TaskType.EDGE_FUNCTION], leaseSeconds: 900,
          concurrencyByProject: DEFAULT_CONCURRENCY_PER_PROJECT,
        });
        if (!task) break;
        const project = await projectRepository.findByRef(task.project_ref);
        if (!project || project.status !== "active") {
          await this.finishAttempt(task, { status: "cancelled", error: !project ? "Project not found" : `Project is ${project.status}` });
          continue;
        }
        void this.execute(task).catch((error: unknown) => {
          logger.error("[BackgroundFunctionWorker] unhandled task execution failure", {
            taskId: task.id, projectRef: task.project_ref,
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

  private async finishAttempt(task: ProjectTask, completion: BackgroundAttemptCompletion): Promise<boolean> {
    const receipt = await backgroundAttemptStore.finish(task, completion);
    if (!receipt) {
      logger.warn("[BackgroundFunctionWorker] stale attempt outcome ignored", {
        taskId: task.id, projectRef: task.project_ref, attempt: task.attempt,
      });
      return false;
    }
    // Only the committed receipt can drive a notification. In particular, a
    // cancellation that wins the transaction must never be broadcast as success.
    broadcastTaskUpdate({
      taskId: task.id, projectRef: task.project_ref, taskType: task.task_type,
      status: receipt.status as TaskStatus,
      ...(receipt.status === completion.status && completion.error ? { error: completion.error } : {}),
    });
    return true;
  }

  private async execute(task: ProjectTask) {
    const project = await projectRepository.findByRef(task.project_ref);
    if (!project || project.status !== "active") {
      await this.finishAttempt(task, { status: "cancelled", error: !project ? "Project not found" : `Project is ${project.status}` });
      return;
    }
    const leaseSeconds = computeLeaseSeconds(task.timeout_sec);
    if (!await backgroundAttemptStore.renew(task, leaseSeconds)) return;

    let cleanupMirror = false;
    let stopHeartbeat: (() => void) | undefined;
    const controller = new AbortController();
    let invocationRequest: Request | undefined;
    let invocationStatus = 500;
    let leaseLost = false;
    let startedAt = Date.now();
    try {
      try { await assertBackgroundInvokerUserExists(task); }
      catch (error) { await this.finishAttempt(task, failureOutcome(task, error)); return; }

      const mirror = await createBackgroundTaskMirrorIfUserExists(task);
      if (mirror.degraded) logger.warn("[BackgroundFunctionWorker] mirror check degraded", {
        taskId: task.id, projectRef: task.project_ref,
      });
      try {
        if (!await backgroundAttemptStore.start(task, leaseSeconds)) return;
      } catch (error) {
        // No provider request has been sent, so this failure can safely follow
        // the preflight retry policy (provided this attempt still owns its lease).
        cleanupMirror = await this.finishAttempt(task, failureOutcome(task, error));
        return;
      }
      // The mirror is evidence only. Always recheck GoTrue immediately before dispatch.
      try { await assertBackgroundInvokerUserExists(task); }
      catch (error) { cleanupMirror = await this.finishAttempt(task, failureOutcome(task, error)); return; }

      this.activeAttempts.set(task.id, { attempt: task.attempt, controller });
      broadcastTaskUpdate({ taskId: task.id, projectRef: task.project_ref, taskType: task.task_type, status: TaskStatus.RUNNING });
      stopHeartbeat = startBackgroundLeaseHeartbeat({
        renew: () => backgroundAttemptStore.renew(task, leaseSeconds),
        onLost: () => {
          leaseLost = true;
          controller.abort(new Error("Background attempt lease lost or cancellation requested"));
        },
      });
      startedAt = Date.now();
      const logs: NonNullable<BackgroundAttemptCompletion["logs"]> = [];
      let completion: BackgroundAttemptCompletion;
      try {
        invocationRequest = buildInvocationRequest(task, controller.signal);
        const { dispatchBackgroundFunction } = await importDispatcher();
        const response = await dispatchBackgroundFunction({
          projectRef: task.project_ref, functionSlug: task.function_slug || "", request: invocationRequest,
          onLog: (entry) => { logs.push(entry); if (logs.length > 200) logs.shift(); },
        });
        invocationStatus = response.status;
        const durationMs = Math.max(0, Date.now() - startedAt);
        if (response.status === 499) {
          completion = { status: "cancelled", error: "Cancelled by user", responseStatus: response.status, durationMs, logs };
        } else if (response.status >= 200 && response.status < 300) {
          completion = { status: "succeeded", responseStatus: response.status, durationMs, logs,
            result: { status: response.status, headers: response.headers, body: response.bodyText.slice(0, 16_384) } };
        } else {
          throw new Error(`Background function returned HTTP ${response.status}`);
        }
      } catch (error: unknown) {
        completion = leaseLost
          ? { status: "dead_lettered", error: "Background invocation outcome is unknown after lease verification failed", durationMs: Math.max(0, Date.now() - startedAt), logs }
          : { ...failureOutcome(task, error, Math.max(0, Date.now() - startedAt)), logs };
      }
      stopHeartbeat();
      // OUTSIDE the invocation catch: an uncertain database commit must not be
      // reinterpreted as a provider failure and overwritten with retry_scheduled.
      cleanupMirror = await this.finishAttempt(task, completion);
    } finally {
      stopHeartbeat?.();
      if (this.activeAttempts.get(task.id)?.controller === controller) this.activeAttempts.delete(task.id);
      const parent = parseTaskTraceparent(invocationRequest?.headers.get("traceparent"));
      if (invocationRequest) recordBackgroundObservation((startedAt - new Date(task.created_at).valueOf()) / 1000, invocationStatus >= 400);
      if (parent?.flags === "01") {
        const origin = parseTaskTraceparent((task.payload?.trace as { traceparent?: string } | undefined)?.traceparent);
        logger.info("[Trace] background attempt", {
          schema: "supacloud.trace-span.v1", projectRef: task.project_ref,
          traceId: parent.traceId, spanId: parent.spanId, parentSpanId: origin?.spanId ?? null,
          operation: "background.attempt", taskId: task.id, attempt: task.attempt || 1,
          durationMs: Math.max(0, Date.now() - startedAt), status: invocationStatus,
        });
      }
      // A duplicate start or uncertain commit must not remove a live owner's evidence.
      if (cleanupMirror) await cleanupBackgroundTaskMirrorEvidence(task);
    }
  }

  async cancel(taskId: string): Promise<boolean> {
    const task = await taskRepository.getTaskById(taskId);
    if (!task) return false;
    if (task.task_type === TaskType.EDGE_FUNCTION) {
      const receipt = await backgroundAttemptStore.requestCancellation(task);
      if (!receipt) return false;
      const active = this.activeAttempts.get(task.id);
      if (active?.attempt === receipt.attempt) active.controller.abort(new Error("Cancelled by user"));
      // This confirms durable acceptance, not provider termination. A worker on
      // another node observes the flag via its heartbeat. The API returns the
      // actual task state (running + cancel_requested_at until acknowledged).
      return true;
    }
    // Do not change non-edge executors or pgflow's own action semantics.
    await taskRepository.requestTaskCancellation(taskId, "Cancelled by user");
    if (task.status === TaskStatus.PENDING || task.status === TaskStatus.RETRY_SCHEDULED) {
      await taskRepository.cancelTask(taskId, "Cancelled by user");
      return true;
    }
    return requestRuntimeCancellation(taskId);
  }
}

export { getInvokerUnknownMetrics };
export const backgroundFunctionWorker = new BackgroundFunctionWorker();
