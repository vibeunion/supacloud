import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ProjectTask } from "../../src/db";
import { TaskStatus, TaskType } from "../../src/db";
import { DEFAULT_BACKGROUND_TASK_SETTINGS } from "../../src/config/background-task-settings";
import { config } from "../../src/config";
import { taskRepository } from "../../src/repositories/task.repository";
import { backgroundAttemptStore } from "../../src/services/background-attempt.service";
import { projectRepository } from "../../src/repositories/project.repository";
import * as ws from "../../src/routes/ws";
import * as dispatcher from "../../src/services/background-runtime-dispatcher";
import * as db from "../../src/db";
import * as pgListen from "../../src/lib/pg-listen";
import * as mirrors from "../../src/services/background-task.service";
import * as heartbeat from "../../src/utils/background-lease-heartbeat";

const claim = spyOn(taskRepository, "claimNextTask");
const getTask = spyOn(taskRepository, "getTaskById");
const legacyCancel = spyOn(taskRepository, "cancelTask");
const legacySuccess = spyOn(taskRepository, "markTaskSucceeded");
const legacyRetry = spyOn(taskRepository, "scheduleRetry");
const renew = spyOn(backgroundAttemptStore, "renew");
const startAttempt = spyOn(backgroundAttemptStore, "start");
const finish = spyOn(backgroundAttemptStore, "finish");
const requestCancellation = spyOn(backgroundAttemptStore, "requestCancellation");
const recoverCancelled = spyOn(backgroundAttemptStore, "recoverCancelled");
const project = spyOn(projectRepository, "findByRef");
const broadcast = spyOn(ws, "broadcastTaskUpdate");
const dispatch = spyOn(dispatcher, "dispatchBackgroundFunction");
const resolveDb = spyOn(db, "resolveDbName");
const projectDb = spyOn(db, "getProjectDb");
const closeListener = mock(() => {});
const listen = spyOn(pgListen, "createPgListener");
const createMirror = spyOn(mirrors, "createBackgroundTaskMirrorIfUserExists");
const removeMirror = spyOn(mirrors, "removeBackgroundTaskMirror");
const stopHeartbeat = mock(() => {});
let heartbeatOptions: Parameters<typeof heartbeat.startBackgroundLeaseHeartbeat>[0] | undefined;
const startHeartbeat = spyOn(heartbeat, "startBackgroundLeaseHeartbeat");
const { BackgroundFunctionWorker, buildInvocationRequest, computeLeaseSeconds, computeRetryDelayMs,
  getInvokerUnknownMetrics, resolveBackgroundConcurrencyPerProject } = await import("../../src/services/background-function-worker");
const originalOwner = config.authRuntimeOwnerRef;

function makeTask(overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: "tsk_1", project_ref: "proj_1", task_type: TaskType.EDGE_FUNCTION, status: TaskStatus.LEASED,
    payload: { method: "POST", path: "/generate", query: "", headers: {}, body: null, auth: {} },
    error: null, retries: 0, attempt: 1, max_attempts: 3, next_run_at: new Date(),
    lease_until: new Date(Date.now() + 900_000), started_at: null, completed_at: null, timeout_sec: 300,
    idempotency_key: null, trace_id: "trace_abc", invoker_user_id: null, auth_authority_ref: "proj_1",
    function_slug: "my-function", function_version: null, result: null, created_at: new Date(), updated_at: new Date(),
    ...overrides,
  };
}
function userTask(overrides: Partial<ProjectTask> = {}): ProjectTask {
  return makeTask({ payload: { method: "POST", path: "/", query: "", headers: {}, body: null,
    auth: { kind: "jwt", invoker_user_id: "00000000-0000-4000-8000-000000000001", invoker_role: "authenticated" } }, ...overrides });
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for test condition");
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
const execute = (worker: InstanceType<typeof BackgroundFunctionWorker>, task: ProjectTask) => (worker as any).execute(task) as Promise<void>;

beforeEach(() => {
  for (const stub of [claim, getTask, legacyCancel, legacySuccess, legacyRetry, renew, startAttempt, finish,
    requestCancellation, recoverCancelled, project, broadcast, dispatch, resolveDb, projectDb, listen,
    createMirror, removeMirror, startHeartbeat, stopHeartbeat, closeListener]) stub.mockReset();
  config.authRuntimeOwnerRef = "";
  claim.mockResolvedValue(null);
  getTask.mockResolvedValue(null);
  legacyCancel.mockImplementation(() => { throw new Error("Unfenced edge cancellation"); });
  legacySuccess.mockImplementation(() => { throw new Error("Unfenced edge success"); });
  legacyRetry.mockImplementation(() => { throw new Error("Unfenced edge retry"); });
  renew.mockResolvedValue(true);
  startAttempt.mockResolvedValue(true);
  finish.mockImplementation(async (task, completion) => ({ status: completion.status, attempt: task.attempt }));
  requestCancellation.mockImplementation(async task => ({ status: "running", attempt: task.attempt }));
  recoverCancelled.mockResolvedValue(0);
  project.mockResolvedValue({ ref: "proj_1", status: "active" } as any);
  broadcast.mockImplementation(() => {});
  dispatch.mockResolvedValue({ status: 200, headers: {}, bodyText: "hello", logs: [] });
  resolveDb.mockResolvedValue("tenant_proj_1");
  projectDb.mockImplementation(() => (async () => [{ exists: 1 }]) as any);
  listen.mockImplementation(() => ({ close: closeListener }));
  createMirror.mockResolvedValue({ inserted: true, userExists: true });
  removeMirror.mockResolvedValue(true);
  heartbeatOptions = undefined;
  startHeartbeat.mockImplementation(options => { heartbeatOptions = options; return stopHeartbeat; });
});
afterAll(() => { config.authRuntimeOwnerRef = originalOwner; mock.restore(); });

describe("worker lifecycle and notifications", () => {
  test("starts listener and fallback poll, and closes both on stop", () => {
    const worker = new BackgroundFunctionWorker();
    worker.start(60_000);
    expect((worker as any).isRunning).toBe(true);
    expect((worker as any).intervalId).toBeDefined();
    expect(listen).toHaveBeenCalledWith(expect.objectContaining({ channels: ["task_pending", "task_retry_scheduled"] }));
    worker.stop();
    expect((worker as any).isRunning).toBe(false);
    expect((worker as any).intervalId).toBeUndefined();
    expect(closeListener).toHaveBeenCalledTimes(1);
  });
  test("start is idempotent", () => {
    const worker = new BackgroundFunctionWorker(); worker.start(60_000); worker.start(60_000); worker.stop();
    expect(listen).toHaveBeenCalledTimes(1);
  });
  test("listener failure retains polling", () => {
    listen.mockImplementationOnce(() => { throw new Error("offline"); });
    const worker = new BackgroundFunctionWorker(); worker.start(60_000);
    expect((worker as any).intervalId).toBeDefined(); worker.stop();
  });
  test("filters non-edge and malformed notifications", () => {
    const worker = new BackgroundFunctionWorker() as any;
    expect(worker.isEdgeFunctionNotification(JSON.stringify({ task_type: TaskType.PROVISION_DB }))).toBe(false);
    expect(worker.isEdgeFunctionNotification(JSON.stringify({ task_type: TaskType.EDGE_FUNCTION }))).toBe(true);
    expect(worker.isEdgeFunctionNotification("invalid")).toBe(false);
  });
  test("retry notifications schedule a delayed wake", async () => {
    const worker = new BackgroundFunctionWorker() as any;
    const wake = spyOn(worker, "wake").mockImplementation(() => {}); worker.isRunning = true;
    worker.scheduleDelayedWakeup(JSON.stringify({ next_run_at: new Date(0).toISOString() }));
    await until(() => wake.mock.calls.length === 1); worker.stop(); wake.mockRestore();
  });
  test("empty poll checks cancellation recovery and preserves concurrency settings", async () => {
    const worker = new BackgroundFunctionWorker() as any; worker.isRunning = true;
    await worker.poll(); worker.stop();
    expect(recoverCancelled).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim.mock.calls[0][0].concurrencyByProject).toBeLessThanOrEqual(DEFAULT_BACKGROUND_TASK_SETTINGS.concurrency);
    expect(dispatch).not.toHaveBeenCalled();
  });
  for (const state of [null, "paused"] as const) test(`disabled project ${state} uses fenced finalization`, async () => {
    const worker = new BackgroundFunctionWorker() as any; worker.isRunning = true;
    const task = makeTask(); claim.mockResolvedValueOnce(task);
    project.mockResolvedValue(state ? { ref: "proj_1", status: state } as any : null);
    await worker.poll(); worker.stop();
    expect(finish).toHaveBeenCalledWith(task, expect.objectContaining({ status: "cancelled" }));
    expect(legacyCancel).not.toHaveBeenCalled();
  });
  test("a slow task does not block dispatching the next claim", async () => {
    const worker = new BackgroundFunctionWorker() as any; worker.isRunning = true;
    const first = makeTask(), second = makeTask({ id: "tsk_2" });
    const release = deferred(); const seen: string[] = [];
    claim.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    dispatch.mockImplementation(async ({ request }) => {
      const id = request.headers.get("x-supacloud-task-id")!; seen.push(id);
      if (id === first.id) await release.promise;
      return { status: 200, headers: {}, bodyText: "", logs: [] };
    });
    const polling = worker.poll();
    try { await until(() => seen.length === 2); expect(claim).toHaveBeenCalledTimes(3); }
    finally { release.resolve(); await polling; await until(() => finish.mock.calls.length === 2); worker.stop(); }
  });
});

describe("attempt fencing and completion", () => {
  test("lost initial lease never dispatches or broadcasts a false cancellation", async () => {
    renew.mockResolvedValue(false); await execute(new BackgroundFunctionWorker(), makeTask());
    expect(startAttempt).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled(); expect(broadcast).not.toHaveBeenCalled();
  });
  test("a duplicate/stale start never dispatches or finalizes another invocation", async () => {
    startAttempt.mockResolvedValue(false); await execute(new BackgroundFunctionWorker(), makeTask());
    expect(dispatch).not.toHaveBeenCalled(); expect(finish).not.toHaveBeenCalled(); expect(removeMirror).not.toHaveBeenCalled();
  });
  test("success is committed once with its attempt history", async () => {
    const task = makeTask({ attempt: 2 }); await execute(new BackgroundFunctionWorker(), task);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith(task, expect.objectContaining({ status: "succeeded", result: expect.objectContaining({ body: "hello" }) }));
    expect(legacySuccess).not.toHaveBeenCalled(); expect(legacyRetry).not.toHaveBeenCalled();
    expect(stopHeartbeat).toHaveBeenCalled();
  });
  test("stale success is not broadcast", async () => {
    finish.mockResolvedValue(null); await execute(new BackgroundFunctionWorker(), makeTask());
    expect(broadcast.mock.calls.some(([value]) => value.status === TaskStatus.SUCCEEDED)).toBe(false);
  });
  test("cancelled receipt wins over provider success", async () => {
    finish.mockResolvedValue({ status: "cancelled", attempt: 1 }); await execute(new BackgroundFunctionWorker(), makeTask());
    expect(broadcast.mock.calls.at(-1)?.[0].status).toBe(TaskStatus.CANCELLED);
    expect(broadcast.mock.calls.some(([value]) => value.status === TaskStatus.SUCCEEDED)).toBe(false);
  });
  test("an uncertain COMMIT is not reinterpreted as an invocation failure", async () => {
    finish.mockRejectedValue(new Error("commit acknowledgement lost"));
    await expect(execute(new BackgroundFunctionWorker(), makeTask())).rejects.toThrow("commit acknowledgement lost");
    expect(finish).toHaveBeenCalledTimes(1); expect(legacyRetry).not.toHaveBeenCalled(); expect(stopHeartbeat).toHaveBeenCalled();
    expect(removeMirror).not.toHaveBeenCalled();
  });
  for (const [attempt, outcome] of [[1, "retry_scheduled"], [3, "dead_lettered"]] as const) test(`HTTP failure attempt ${attempt} retains retry/DLQ policy`, async () => {
    dispatch.mockResolvedValue({ status: 503, headers: {}, bodyText: "", logs: [] });
    await execute(new BackgroundFunctionWorker(), makeTask({ attempt }));
    expect(finish.mock.calls[0][1]).toMatchObject({ status: outcome, responseStatus: 503 });
    if (attempt === 1) expect(finish.mock.calls[0][1].nextRunAt).toBeInstanceOf(Date);
  });
  test("HTTP 499 commits cancellation", async () => {
    dispatch.mockResolvedValue({ status: 499, headers: {}, bodyText: "", logs: [] });
    await execute(new BackgroundFunctionWorker(), makeTask());
    expect(finish.mock.calls[0][1].status).toBe("cancelled");
  });
  test("lease verification failure aborts only the bound request and does not auto-retry an unknown outcome", async () => {
    dispatch.mockImplementation(async ({ request }) => {
      heartbeatOptions!.onLost(new Error("database offline"));
      expect(request.signal.aborted).toBe(true); throw request.signal.reason;
    });
    await execute(new BackgroundFunctionWorker(), makeTask());
    expect(finish.mock.calls[0][1].status).toBe("dead_lettered");
    expect(finish.mock.calls[0][1].nextRunAt).toBeUndefined();
  });
});

describe("durable cancellation", () => {
  test("queued cancellation is a single atomic operation", async () => {
    const task = makeTask({ status: TaskStatus.PENDING, attempt: 0 }); getTask.mockResolvedValue(task);
    requestCancellation.mockResolvedValue({ status: "cancelled", attempt: 0 });
    expect(await new BackgroundFunctionWorker().cancel(task.id)).toBe(true);
    expect(requestCancellation).toHaveBeenCalledWith(task); expect(legacyCancel).not.toHaveBeenCalled();
  });
  test("remote-worker cancellation acknowledges the stored flag, not runtime termination", async () => {
    getTask.mockResolvedValue(makeTask({ status: TaskStatus.RUNNING }));
    expect(await new BackgroundFunctionWorker().cancel("tsk_1")).toBe(true);
    expect(requestCancellation).toHaveBeenCalledTimes(1);
  });
  test("missing or already completed tasks cannot be cancelled", async () => {
    const worker = new BackgroundFunctionWorker(); expect(await worker.cancel("missing")).toBe(false);
    getTask.mockResolvedValue(makeTask({ status: TaskStatus.SUCCEEDED })); requestCancellation.mockResolvedValue(null);
    expect(await worker.cancel("tsk_1")).toBe(false);
  });
  test("local cancellation propagates to the actual request signal", async () => {
    const task = makeTask(); getTask.mockResolvedValue(task);
    const worker = new BackgroundFunctionWorker();
    dispatch.mockImplementation(async ({ request }) => {
      expect(await worker.cancel(task.id)).toBe(true); expect(request.signal.aborted).toBe(true);
      throw request.signal.reason;
    });
    finish.mockResolvedValue({ status: "cancelled", attempt: 1 });
    await execute(worker, task); expect((worker as any).activeAttempts.size).toBe(0);
  });
  test("a delayed cancellation for an old attempt cannot abort a newer local attempt", async () => {
    const task = makeTask(); getTask.mockResolvedValue(task); const worker = new BackgroundFunctionWorker() as any;
    const newer = new AbortController(); worker.activeAttempts.set(task.id, { attempt: 2, controller: newer });
    await worker.cancel(task.id); expect(newer.signal.aborted).toBe(false);
  });
});

describe("authoritative invoker and mirror integrity", () => {
  test("deleted invoker is dead-lettered before dispatch", async () => {
    projectDb.mockImplementation(() => (async () => []) as any);
    await execute(new BackgroundFunctionWorker(), userTask());
    expect(dispatch).not.toHaveBeenCalled();
    expect(finish.mock.calls[0][1]).toMatchObject({ status: "dead_lettered", responseStatus: 410, error: "Background invoker user no longer exists" });
  });
  test("unknown invoker database state retries only before dispatch", async () => {
    projectDb.mockImplementation(() => (async () => { throw new Error("offline"); }) as any);
    await execute(new BackgroundFunctionWorker(), userTask());
    expect(finish.mock.calls[0][1].status).toBe("retry_scheduled"); expect(startAttempt).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
  });
  test("degraded mirror does not replace the authoritative read", async () => {
    const task = userTask(); createMirror.mockResolvedValue({ inserted: false, userExists: true, degraded: true });
    await execute(new BackgroundFunctionWorker(), task);
    expect(startAttempt).toHaveBeenCalled(); expect(dispatch).toHaveBeenCalled(); expect(removeMirror).toHaveBeenCalledWith(task);
  });
  test("running-transition user deletion fence dead-letters without dispatch", async () => {
    startAttempt.mockRejectedValue(new Error("USER_DELETION_FENCED")); await execute(new BackgroundFunctionWorker(), userTask());
    expect(finish.mock.calls[0][1]).toMatchObject({ status: "dead_lettered", error: "USER_DELETION_FENCED" }); expect(dispatch).not.toHaveBeenCalled();
  });
  test("deletion between preflight and the final gate prevents dispatch", async () => {
    let reads = 0; projectDb.mockImplementation(() => (async () => ++reads === 1 ? [{ exists: 1 }] : []) as any);
    await execute(new BackgroundFunctionWorker(), userTask());
    expect(startAttempt).toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled(); expect(finish.mock.calls[0][1].responseStatus).toBe(410);
  });
  for (const ownerExists of [false, true]) test(`shared authority is used even when child residue disagrees (${ownerExists})`, async () => {
    config.authRuntimeOwnerRef = "auth-owner";
    const task = userTask({ auth_authority_ref: "auth-owner", invoker_user_id: "00000000-0000-4000-8000-000000000001" });
    resolveDb.mockImplementation(async ref => `tenant_${ref}`);
    projectDb.mockImplementation(name => (async () => name === "tenant_auth-owner" ? (ownerExists ? [{}] : []) : (ownerExists ? [] : [{}])) as any);
    await execute(new BackgroundFunctionWorker(), task);
    expect(resolveDb.mock.calls.every(([ref]) => ref === "auth-owner")).toBe(true);
    expect(dispatch.mock.calls.length).toBe(ownerExists ? 1 : 0);
  });
  for (const payloadUserId of [undefined, 42, "00000000-0000-4000-8000-000000000099"]) test(`invalid authoritative invoker pairing ${payloadUserId}`, async () => {
    await execute(new BackgroundFunctionWorker(), makeTask({ invoker_user_id: "00000000-0000-4000-8000-000000000001",
      payload: { auth: { kind: "jwt", invoker_user_id: payloadUserId } } }));
    expect(finish.mock.calls[0][1]).toMatchObject({ status: "dead_lettered", error: "Background task invoker identity is inconsistent" });
    expect(dispatch).not.toHaveBeenCalled();
  });
  test("changed runtime authority fails closed", async () => {
    config.authRuntimeOwnerRef = "new-owner"; await execute(new BackgroundFunctionWorker(), userTask({ auth_authority_ref: "old-owner" }));
    expect(finish.mock.calls[0][1].error).toBe("Background task auth authority is inconsistent"); expect(resolveDb).not.toHaveBeenCalled();
  });
  test("positive invoker existence is rechecked twice for every task", async () => {
    const worker = new BackgroundFunctionWorker(); await execute(worker, userTask()); const reads = resolveDb.mock.calls.length;
    await execute(worker, userTask({ id: "tsk_2" })); expect(resolveDb.mock.calls.length).toBe(reads + 2);
  });
  test("negative mirror hint cannot override the direct GoTrue read", async () => {
    createMirror.mockResolvedValue({ inserted: false, userExists: false }); await execute(new BackgroundFunctionWorker(), userTask());
    expect(dispatch).toHaveBeenCalled(); expect(finish.mock.calls[0][1].status).toBe("succeeded");
  });
  test("cleanup always carries the original task and attempt", async () => {
    const task = userTask({ attempt: 2 }); await execute(new BackgroundFunctionWorker(), task); expect(removeMirror).toHaveBeenCalledWith(task);
  });
});

describe("invocation and production helpers", () => {
  test("signs trusted headers and forwards the abort signal", () => {
    const controller = new AbortController();
    const request = buildInvocationRequest(makeTask({ attempt: 2, payload: { method: "POST", path: "/work", query: "?a=1",
      auth: { kind: "jwt", invoker_user_id: "user_1", invoker_role: "authenticated" } } }), controller.signal);
    expect(request.url).toContain("/internal/background/proj_1/my-function/work?a=1");
    expect(request.headers.get("x-supacloud-attempt")).toBe("2");
    expect(request.headers.get("x-supacloud-invoker-user-id")).toBe("user_1");
    expect(request.headers.get("x-supacloud-signature-version")).toBe("v1");
    expect(request.headers.get("x-supacloud-signature")).toMatch(/^[a-f0-9]{64}$/);
    controller.abort(); expect(request.signal.aborted).toBe(true);
  });
  for (const [attempt, delay] of [[1, 5000], [3, 20000], [6, 160000], [10, 160000]]) test(`actual retry delay at ${attempt}`, () => {
    expect(computeRetryDelayMs(attempt)).toBe(delay);
  });
  for (const [timeout, seconds] of [[null, 330], [10, 60], [1800, 1800], [300, 330]] as const) test(`actual lease duration at ${timeout}`, () => {
    expect(computeLeaseSeconds(timeout)).toBe(seconds);
  });
  test("concurrency never exceeds existing configured ceiling", () => {
    expect(resolveBackgroundConcurrencyPerProject("999999")).toBe(DEFAULT_BACKGROUND_TASK_SETTINGS.concurrency);
    expect(resolveBackgroundConcurrencyPerProject()).toBeGreaterThan(0);
  });
  test("unknown-invoker metrics retain a closed safety circuit", () => {
    const metrics = getInvokerUnknownMetrics(); expect(metrics.circuit_open).toBe(false);
    expect(typeof metrics.unknown_window_count).toBe("number"); expect(typeof metrics.circuit_open_until).toBe("number");
  });
  test("source contains no positive authorization cache or unfenced edge outcomes", () => {
    const source = readFileSync(new URL("../../src/services/background-function-worker.ts", import.meta.url), "utf8");
    expect(source).not.toContain("invokerCache"); expect(source).not.toContain("invokerInflight");
    expect(source).toContain("safety circuit is open");
    const execution = source.slice(source.indexOf("private async execute"), source.indexOf("async cancel("));
    expect(execution).not.toContain("Promise.all(");
    expect(execution).not.toContain("taskRepository.markTask");
    expect(execution).not.toContain("taskRepository.scheduleRetry");
    expect(execution.indexOf("assertBackgroundInvokerUserExists(task)")).toBeLessThan(execution.indexOf("createBackgroundTaskMirrorIfUserExists(task)"));
    expect(execution.indexOf("createBackgroundTaskMirrorIfUserExists(task)")).toBeLessThan(execution.indexOf("backgroundAttemptStore.start(task"));
    expect(execution.lastIndexOf("assertBackgroundInvokerUserExists(task)")).toBeGreaterThan(execution.indexOf("backgroundAttemptStore.start(task"));
  });
});
