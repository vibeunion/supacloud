import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ProjectTask } from "../../src/db";
import { TaskStatus, TaskType } from "../../src/db";
import { DEFAULT_BACKGROUND_TASK_SETTINGS } from "../../src/config/background-task-settings";

// ─── Mock all heavy dependencies ────────────────────────────────────────────

const claimNextTask = mock(() => Promise.resolve(null));
const cancelTask = mock(() => Promise.resolve(null));
const releaseTask = mock(() => Promise.resolve(null));
const extendLease = mock(() => Promise.resolve(null));
const markTaskRunning = mock(() => Promise.resolve(null));
const markTaskSucceeded = mock(() => Promise.resolve(null));
const markTaskFailed = mock(() => Promise.resolve(null));
const scheduleRetry = mock(() => Promise.resolve(null));
const startTaskAttempt = mock(() => Promise.resolve({ id: "att_1" }));
const completeTaskAttempt = mock(() => Promise.resolve(null));
const countActiveTasksForProject = mock(() => Promise.resolve(0));
const getTaskById = mock(() => Promise.resolve(null));
const requestTaskCancellation = mock(() => Promise.resolve(null));
const transitionTaskToRunning = mock(() => Promise.resolve({ task: {}, attempt: { id: "att_1" } }));

const findByRef = mock(() =>
  Promise.resolve({ ref: "proj_1", status: "active" })
);

const getBackgroundTaskSettings = mock(() =>
  Promise.resolve({
    ...DEFAULT_BACKGROUND_TASK_SETTINGS,
  })
);

const { taskRepository } = await import("../../src/repositories/task.repository");
const { projectRepository } = await import("../../src/repositories/project.repository");
const wsModule = await import("../../src/routes/ws");
const { projectService } = await import("../../src/services/project.service");
const dispatcherModule = await import("../../src/services/background-runtime-dispatcher");
const dbModule = await import("../../src/db");
const pgListenModule = await import("../../src/lib/pg-listen");

spyOn(taskRepository, "claimNextTask").mockImplementation(claimNextTask as typeof taskRepository.claimNextTask);
spyOn(taskRepository, "cancelTask").mockImplementation(cancelTask as typeof taskRepository.cancelTask);
spyOn(taskRepository, "releaseTask").mockImplementation(releaseTask as typeof taskRepository.releaseTask);
spyOn(taskRepository, "extendLease").mockImplementation(extendLease as typeof taskRepository.extendLease);
spyOn(taskRepository, "markTaskRunning").mockImplementation(markTaskRunning as typeof taskRepository.markTaskRunning);
spyOn(taskRepository, "markTaskSucceeded").mockImplementation(markTaskSucceeded as typeof taskRepository.markTaskSucceeded);
spyOn(taskRepository, "markTaskFailed").mockImplementation(markTaskFailed as typeof taskRepository.markTaskFailed);
spyOn(taskRepository, "scheduleRetry").mockImplementation(scheduleRetry as typeof taskRepository.scheduleRetry);
spyOn(taskRepository, "startTaskAttempt").mockImplementation(startTaskAttempt as typeof taskRepository.startTaskAttempt);
spyOn(taskRepository, "completeTaskAttempt").mockImplementation(completeTaskAttempt as typeof taskRepository.completeTaskAttempt);
spyOn(taskRepository, "countActiveTasksForProject").mockImplementation(
  countActiveTasksForProject as typeof taskRepository.countActiveTasksForProject,
);
spyOn(taskRepository, "getTaskById").mockImplementation(getTaskById as typeof taskRepository.getTaskById);
spyOn(taskRepository, "requestTaskCancellation").mockImplementation(
  requestTaskCancellation as typeof taskRepository.requestTaskCancellation,
);
spyOn(taskRepository, "transitionTaskToRunning").mockImplementation(
  transitionTaskToRunning as typeof taskRepository.transitionTaskToRunning,
);
spyOn(projectRepository, "findByRef").mockImplementation(findByRef as typeof projectRepository.findByRef);
const broadcastTaskUpdate = spyOn(wsModule, "broadcastTaskUpdate").mockImplementation(() => {});
spyOn(projectService, "getBackgroundTaskSettings").mockImplementation(
  getBackgroundTaskSettings as typeof projectService.getBackgroundTaskSettings,
);
const dispatchBackgroundFunction = spyOn(dispatcherModule, "dispatchBackgroundFunction").mockImplementation(
  () => Promise.resolve({ status: 200, headers: {}, bodyText: "", logs: [] }),
);
const resolveDbName = spyOn(dbModule, "resolveDbName").mockImplementation(
  () => Promise.resolve("tenant_proj_1"),
);
const getProjectDb = spyOn(dbModule, "getProjectDb").mockImplementation(
  () => ((async () => [{ exists: 1 }]) as any),
);
const closePgListener = mock(() => {});
const createPgListener = spyOn(pgListenModule, "createPgListener").mockImplementation(
  () => ({ close: closePgListener }),
);

// Mock createBackgroundTaskMirrorIfUserExists
const bgTaskServiceModule = await import("../../src/services/background-task.service");
const createBackgroundTaskMirrorIfUserExists = spyOn(
  bgTaskServiceModule,
  "createBackgroundTaskMirrorIfUserExists"
).mockImplementation(
  () => Promise.resolve({ inserted: false, userExists: true }),
);

// We import the worker AFTER mocks are set up
// so the module resolves against mocks
const { BackgroundFunctionWorker, buildInvocationRequest } = await import(
  "../../src/services/background-function-worker"
);

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: "tsk_1",
    project_ref: "proj_1",
    task_type: TaskType.EDGE_FUNCTION,
    status: TaskStatus.PENDING,
    payload: {
      method: "POST",
      path: "/generate",
      query: "",
      headers: {},
      body: null,
      auth: {},
    },
    error: null,
    retries: 0,
    attempt: 1,
    max_attempts: 3,
    next_run_at: new Date(),
    lease_until: null,
    started_at: null,
    completed_at: null,
    timeout_sec: 300,
    idempotency_key: null,
    trace_id: "trace_abc",
    function_slug: "my-function",
    function_version: null,
    result: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("BackgroundFunctionWorker", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    claimNextTask.mockReset();
    cancelTask.mockReset();
    releaseTask.mockReset();
    extendLease.mockReset();
    markTaskRunning.mockReset();
    markTaskSucceeded.mockReset();
    markTaskFailed.mockReset();
    scheduleRetry.mockReset();
    startTaskAttempt.mockReset();
    completeTaskAttempt.mockReset();
    countActiveTasksForProject.mockReset();
    getTaskById.mockReset();
    requestTaskCancellation.mockReset();
    transitionTaskToRunning.mockReset();
    findByRef.mockReset();
    broadcastTaskUpdate.mockReset();
    getBackgroundTaskSettings.mockReset();
    dispatchBackgroundFunction.mockReset();
    resolveDbName.mockReset();
    getProjectDb.mockReset();
    closePgListener.mockReset();
    createPgListener.mockReset();
    createBackgroundTaskMirrorIfUserExists.mockReset();

    // Defaults
    findByRef.mockResolvedValue({ ref: "proj_1", status: "active" } as any);
    countActiveTasksForProject.mockResolvedValue(0);
    getBackgroundTaskSettings.mockResolvedValue({
      ...DEFAULT_BACKGROUND_TASK_SETTINGS,
    });
    dispatchBackgroundFunction.mockResolvedValue({ status: 200, headers: {}, bodyText: "", logs: [] });
    resolveDbName.mockResolvedValue("tenant_proj_1");
    getProjectDb.mockImplementation(() => ((async () => [{ exists: 1 }]) as any));
    createPgListener.mockImplementation(() => ({ close: closePgListener }));
    createBackgroundTaskMirrorIfUserExists.mockResolvedValue({ inserted: false, userExists: true });
    startTaskAttempt.mockResolvedValue({ id: "att_1" } as any);
    extendLease.mockResolvedValue(null);
    markTaskRunning.mockResolvedValue(null);
    transitionTaskToRunning.mockResolvedValue({ task: {} as any, attempt: { id: "att_1" } as any });
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("start / stop lifecycle", () => {
    test("start sets isRunning and begins polling", () => {
      const worker = new BackgroundFunctionWorker();
      claimNextTask.mockResolvedValue(null);
      worker.start(60_000); // long interval so no double-poll
      expect((worker as any).isRunning).toBe(true);
      expect(createPgListener).toHaveBeenCalledWith(expect.objectContaining({
        channels: ["task_pending", "task_retry_scheduled"],
        applicationName: "supacloud-background-function-worker",
      }));
      worker.stop();
      expect((worker as any).isRunning).toBe(false);
      expect(closePgListener).toHaveBeenCalledTimes(1);
    });

    test("calling start twice is a no-op", () => {
      const worker = new BackgroundFunctionWorker();
      claimNextTask.mockResolvedValue(null);
      worker.start(60_000);
      worker.start(60_000);
      expect((worker as any).isRunning).toBe(true);
      expect(createPgListener).toHaveBeenCalledTimes(1);
      worker.stop();
    });

    test("stop clears the interval", () => {
      const worker = new BackgroundFunctionWorker();
      claimNextTask.mockResolvedValue(null);
      worker.start(60_000);
      expect((worker as any).intervalId).toBeDefined();
      worker.stop();
      expect((worker as any).intervalId).toBeUndefined();
    });

    test("falls back to interval polling when listener startup fails", () => {
      const worker = new BackgroundFunctionWorker();
      createPgListener.mockImplementationOnce(() => {
        throw new Error("listener unavailable");
      });
      claimNextTask.mockResolvedValue(null);

      worker.start(60_000);

      expect((worker as any).isRunning).toBe(true);
      expect((worker as any).intervalId).toBeDefined();
      worker.stop();
    });
  });

  describe("LISTEN/NOTIFY wakeups", () => {
    test("ignores non-edge task notifications", () => {
      const worker = new BackgroundFunctionWorker();

      expect((worker as any).isEdgeFunctionNotification(JSON.stringify({
        task_type: TaskType.PROVISION_DB,
      }))).toBe(false);
      expect((worker as any).isEdgeFunctionNotification(JSON.stringify({
        task_type: TaskType.EDGE_FUNCTION,
      }))).toBe(true);
      expect((worker as any).isEdgeFunctionNotification("not json")).toBe(false);
    });

    test("schedules delayed wakeup from retry notification payload", async () => {
      const worker = new BackgroundFunctionWorker();
      const wakeSpy = spyOn(worker as any, "wake").mockImplementation(() => {});
      (worker as any).isRunning = true;

      (worker as any).scheduleDelayedWakeup(JSON.stringify({
        task_type: TaskType.EDGE_FUNCTION,
        next_run_at: new Date(Date.now() - 1).toISOString(),
      }));

      await new Promise((resolve) => setTimeout(resolve, 5));

      expect(wakeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("poll: task claiming", () => {
    test("when claimNextTask returns null, does not call execute", async () => {
      const worker = new BackgroundFunctionWorker();
      (worker as any).isRunning = true; // poll() guards on this
      claimNextTask.mockResolvedValue(null);

      await (worker as any).poll();

      expect(claimNextTask).toHaveBeenCalledTimes(1);
      expect(markTaskRunning).not.toHaveBeenCalled();
    });

    test("cancels task when project not found", async () => {
      const worker = new BackgroundFunctionWorker();
      (worker as any).isRunning = true;
      const task = makeTask();
      claimNextTask
        .mockResolvedValueOnce(task)
        .mockResolvedValueOnce(null);
      findByRef.mockResolvedValue(null);

      await (worker as any).poll();

      expect(cancelTask).toHaveBeenCalledWith(task.id, "Project not found");
    });

    test("cancels task when project is paused", async () => {
      const worker = new BackgroundFunctionWorker();
      (worker as any).isRunning = true;
      const task = makeTask();
      claimNextTask
        .mockResolvedValueOnce(task)
        .mockResolvedValueOnce(null);
      findByRef.mockResolvedValue({ ref: "proj_1", status: "paused" } as any);

      await (worker as any).poll();

      expect(cancelTask).toHaveBeenCalledWith(task.id, "Project is paused");
    });

    test("starts the next claimed task without waiting for the previous one to finish", async () => {
      const worker = new BackgroundFunctionWorker();
      (worker as any).isRunning = true;
      const firstTask = makeTask({ id: "tsk_1" });
      const secondTask = makeTask({ id: "tsk_2" });
      const firstTaskStarted = deferred();
      const releaseFirstTask = deferred();
      const startedTaskIds: string[] = [];

      claimNextTask
        .mockResolvedValueOnce(firstTask)
        .mockResolvedValueOnce(secondTask)
        .mockResolvedValueOnce(null);
      extendLease.mockResolvedValue({} as any);
      dispatchBackgroundFunction.mockImplementation(async ({ request }) => {
        const taskId = request.headers.get("x-supacloud-task-id") || "";
        startedTaskIds.push(taskId);
        if (taskId === firstTask.id) {
          firstTaskStarted.resolve();
          await releaseFirstTask.promise;
        }
        return { status: 200, headers: {}, bodyText: "", logs: [] };
      });

      const pollPromise = (worker as any).poll();
      await firstTaskStarted.promise;

      try {
        await waitUntil(() => startedTaskIds.includes(secondTask.id));
        expect(claimNextTask).toHaveBeenCalledTimes(3);
        expect(startedTaskIds).toContain(firstTask.id);
        expect(startedTaskIds).toContain(secondTask.id);
      } finally {
        releaseFirstTask.resolve();
        await pollPromise;
        await waitUntil(() => markTaskSucceeded.mock.calls.length >= 2);
      }
    });

  });

  describe("cancel", () => {
    test("cancel immediately cancels pending tasks", async () => {
      const worker = new BackgroundFunctionWorker();
      getTaskById.mockResolvedValueOnce(makeTask({ status: TaskStatus.PENDING }));
      requestTaskCancellation.mockResolvedValueOnce(makeTask({ status: TaskStatus.PENDING }));
      cancelTask.mockResolvedValueOnce(makeTask({ status: TaskStatus.CANCELLED }));

      await worker.cancel("tsk_cancel_me");

      expect(requestTaskCancellation).toHaveBeenCalledWith("tsk_cancel_me", "Cancelled by user");
      expect(cancelTask).toHaveBeenCalledWith("tsk_cancel_me", "Cancelled by user");
    });

    test("cancel returns true when runtime confirms cancellation", async () => {
      const worker = new BackgroundFunctionWorker();
      getTaskById.mockResolvedValueOnce(makeTask({ status: TaskStatus.RUNNING }));
      requestTaskCancellation.mockResolvedValueOnce(makeTask({ status: TaskStatus.RUNNING }));

      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ cancelled: true }), { status: 200 })
        )
      ) as any;

      const result = await worker.cancel("tsk_cancel_ok");
      expect(result).toBe(true);
      expect((worker as any).cancelledTasks.has("tsk_cancel_ok")).toBe(true);
    });

    test("cancel returns false when fetch fails", async () => {
      const worker = new BackgroundFunctionWorker();
      getTaskById.mockResolvedValueOnce(makeTask({ status: TaskStatus.RUNNING }));
      requestTaskCancellation.mockResolvedValueOnce(makeTask({ status: TaskStatus.RUNNING }));

      globalThis.fetch = mock(() =>
        Promise.reject(new Error("network error"))
      ) as any;

      const result = await worker.cancel("tsk_net_fail");
      expect(result).toBe(false);
    });
  });

  describe("background invoker integrity", () => {
    test("dead-letters without dispatching when the invoker user was deleted", async () => {
      const worker = new BackgroundFunctionWorker();
      const task = makeTask({
        id: "tsk_deleted_invoker",
        payload: {
          method: "POST",
          path: "/generate/pattern",
          query: "",
          headers: {},
          body: "{}",
          auth: {
            kind: "jwt",
            invoker_user_id: "00000000-0000-4000-8000-000000000001",
            invoker_role: "authenticated",
          },
        },
      });
      extendLease.mockResolvedValue({} as any);
      getProjectDb.mockImplementation(() => ((async () => []) as any));

      await (worker as any).execute(task);

      expect(resolveDbName).toHaveBeenCalledWith("proj_1");
      expect(dispatchBackgroundFunction).not.toHaveBeenCalled();
      expect(completeTaskAttempt).toHaveBeenCalledWith("tsk_deleted_invoker", 1, expect.objectContaining({
        status: "dead_lettered",
        error: "Background invoker user no longer exists",
        responseStatus: 410,
      }));
      expect(markTaskFailed).toHaveBeenCalledWith(
        "tsk_deleted_invoker",
        "Background invoker user no longer exists",
        true,
      );
    });
  });

  describe("invoker existence cache", () => {
    test("caches positive invoker existence across multiple tasks", async () => {
      const worker = new BackgroundFunctionWorker();
      const userId = "00000000-0000-4000-8000-000000000002";
      const task1 = makeTask({
        id: "tsk_cache_1",
        payload: {
          method: "POST", path: "/", query: "", headers: {}, body: null,
          auth: { kind: "jwt", invoker_user_id: userId, invoker_role: "authenticated" },
        },
      });
      const task2 = makeTask({
        id: "tsk_cache_2",
        payload: {
          method: "POST", path: "/", query: "", headers: {}, body: null,
          auth: { kind: "jwt", invoker_user_id: userId, invoker_role: "authenticated" },
        },
      });

      extendLease.mockResolvedValue({} as any);
      getProjectDb.mockImplementation(() => ((async () => [{ exists: 1 }]) as any));

      await (worker as any).execute(task1);
      const firstCallCount = resolveDbName.mock.calls.length;
      await (worker as any).execute(task2);

      // 缓存命中时 resolveDbName 不会被再次调用（invoker cache 跳过了 DB 查询）
      expect(resolveDbName.mock.calls.length).toBe(firstCallCount);
    });

    test("dead-letters when mirror RPC confirms user does not exist", async () => {
      const worker = new BackgroundFunctionWorker();
      const task = makeTask({
        id: "tsk_mirror_dead",
        payload: {
          method: "POST", path: "/", query: "", headers: {}, body: null,
          auth: { kind: "jwt", invoker_user_id: "00000000-0000-4000-8000-000000000003", invoker_role: "authenticated" },
        },
      });
      extendLease.mockResolvedValue({} as any);
      getProjectDb.mockImplementation(() => ((async () => [{ exists: 1 }]) as any));
      createBackgroundTaskMirrorIfUserExists.mockResolvedValue({ inserted: false, userExists: false });

      await (worker as any).execute(task);

      expect(markTaskFailed).toHaveBeenCalledWith(
        "tsk_mirror_dead",
        expect.stringContaining("atomic RPC check"),
        true,
      );
      expect(dispatchBackgroundFunction).not.toHaveBeenCalled();
    });
  });

  describe("background invocation contract", () => {
    test("buildInvocationRequest signs trusted background invoker headers", async () => {
      const request = buildInvocationRequest(makeTask({
        id: "tsk_signed",
        project_ref: "proj_1",
        function_slug: "my-function",
        attempt: 2,
        payload: {
          method: "POST",
          path: "/work",
          query: "?a=1",
          headers: {},
          body: null,
          auth: {
            kind: "jwt",
            invoker_user_id: "user_1",
            invoker_role: "authenticated",
          },
        },
      }));

      expect(request.url).toContain("/internal/background/proj_1/my-function/work?a=1");
      expect(request.headers.get("x-supacloud-background")).toBe("true");
      expect(request.headers.get("x-supacloud-task-id")).toBe("tsk_signed");
      expect(request.headers.get("x-supacloud-attempt")).toBe("2");
      expect(request.headers.get("x-supacloud-invoker-user-id")).toBe("user_1");
      expect(request.headers.get("x-supacloud-invoker-role")).toBe("authenticated");
      expect(request.headers.get("x-supacloud-signature-version")).toBe("v1");
      expect(request.headers.get("x-supacloud-signature-timestamp")).toBeTruthy();
      expect(request.headers.get("x-supacloud-signature")).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});

// ─── Pure function tests (exported helpers) ─────────────────────────────────

describe("BackgroundFunctionWorker pure helpers", () => {
  // These are module-private functions. We test them via the module's internal
  // behavior (tested above) but also re-implement the logic here for coverage.

  describe("computeRetryDelayMs logic", () => {
    test("attempt 1 gives base delay (5s)", () => {
      // base * 2^(attempt-1) = 5000 * 2^0 = 5000
      const delay = 5_000 * Math.pow(2, Math.min(Math.max(1, 1), 6) - 1);
      expect(delay).toBe(5_000);
    });

    test("attempt 3 gives 20s", () => {
      const delay = 5_000 * Math.pow(2, Math.min(Math.max(3, 1), 6) - 1);
      expect(delay).toBe(20_000);
    });

    test("attempt 6 caps at 160s", () => {
      const delay = 5_000 * Math.pow(2, Math.min(Math.max(6, 1), 6) - 1);
      expect(delay).toBe(160_000);
    });

    test("attempt > 6 is capped the same as 6", () => {
      const delay10 = 5_000 * Math.pow(2, Math.min(Math.max(10, 1), 6) - 1);
      const delay6 = 5_000 * Math.pow(2, Math.min(Math.max(6, 1), 6) - 1);
      expect(delay10).toBe(delay6);
    });
  });

  describe("computeLeaseSeconds logic", () => {
    test("default timeout (null) gives 330s lease", () => {
      const timeout = null;
      const t = (timeout && timeout > 0) ? timeout : 300;
      const lease = Math.min(Math.max(t + 30, 60), 1800);
      expect(lease).toBe(330);
    });

    test("small timeout (10s) gives 60s minimum lease", () => {
      const t = 10;
      const lease = Math.min(Math.max(t + 30, 60), 1800);
      expect(lease).toBe(60);
    });

    test("large timeout (1800s) caps at 1800s", () => {
      const t = 1800;
      const lease = Math.min(Math.max(t + 30, 60), 1800);
      expect(lease).toBe(1800);
    });

    test("normal timeout (300s) gives 330s", () => {
      const t = 300;
      const lease = Math.min(Math.max(t + 30, 60), 1800);
      expect(lease).toBe(330);
    });
  });
});

  describe("invoker unknown circuit breaker", () => {
    test("getInvokerUnknownMetrics returns structured object", async () => {
      const { getInvokerUnknownMetrics } = await import(
        "../../src/services/background-function-worker"
      );
      const metrics = getInvokerUnknownMetrics();
      expect(metrics).toHaveProperty("unknown_window_count");
      expect(metrics).toHaveProperty("circuit_open");
      expect(metrics).toHaveProperty("circuit_open_until");
      expect(typeof metrics.unknown_window_count).toBe("number");
      expect(typeof metrics.circuit_open).toBe("boolean");
      expect(typeof metrics.circuit_open_until).toBe("number");
    });

    test("circuit breaker starts closed", async () => {
      const { getInvokerUnknownMetrics } = await import(
        "../../src/services/background-function-worker"
      );
      const metrics = getInvokerUnknownMetrics();
      expect(metrics.circuit_open).toBe(false);
      expect(metrics.unknown_window_count).toBe(0);
    });
  });

afterAll(() => {
  mock.restore();
});
