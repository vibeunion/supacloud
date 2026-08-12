import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ProjectTask } from "../../src/db";
import { TaskStatus } from "../../src/db";
import { taskRepository } from "../../src/repositories/task.repository";
import { projectRepository } from "../../src/repositories/project.repository";
import { TaskWorker } from "../../src/services/task.worker";
import { databaseService } from "../../src/services/database.service";
import { jwtService } from "../../src/services/jwt.service";
import { storageService } from "../../src/services/storage.service";
import * as wsModule from "../../src/routes/ws";

function failedTask(overrides: Partial<ProjectTask> = {}): ProjectTask {
  const now = new Date();
  return {
    id: "task-retry-1",
    project_ref: "proj-ref",
    task_type: "provision_router",
    status: TaskStatus.FAILED,
    payload: {},
    error: "Task execution failed",
    retries: 1,
    attempt: 1,
    max_attempts: 3,
    next_run_at: null,
    lease_until: null,
    started_at: now,
    completed_at: null,
    timeout_sec: null,
    idempotency_key: null,
    trace_id: null,
    cancel_requested_at: null,
    cancellation_reason: null,
    correlation_id: null,
    business_task_id: null,
    invoker_user_id: null,
    auth_authority_ref: "proj-ref",
    metadata: null,
    function_slug: null,
    function_version: null,
    result: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("TaskWorker delayed retry wakeup", () => {
  afterEach(() => {
    mock.restore();
  });

  test("extracts next_run_at from notification payload", () => {
    const worker = new TaskWorker();
    const nextRunAt = "2026-04-24T12:34:56.000Z";

    expect((worker as any).extractNextRunAt(JSON.stringify({ next_run_at: nextRunAt }))).toEqual(new Date(nextRunAt));
    expect((worker as any).extractNextRunAt(JSON.stringify({ next_run_at: null }))).toBeNull();
    expect((worker as any).extractNextRunAt("not json")).toBeNull();
  });

  test("schedules delayed poll when retry_scheduled notification arrives", async () => {
    const worker = new TaskWorker();
    const pollSpy = spyOn(worker as any, "poll").mockImplementation(() => Promise.resolve());
    (worker as any).isRunning = true;

    (worker as any).scheduleDelayedWakeup(JSON.stringify({
      next_run_at: new Date(Date.now() - 1).toISOString(),
    }));

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(pollSpy).toHaveBeenCalledTimes(1);
  });
});

describe("TaskWorker failure handling", () => {
  afterEach(() => {
    mock.restore();
  });

  test("provision_realtime failure preserves project resources and continues provisioning", async () => {
    const worker = new TaskWorker();
    const markTaskFailedSpy = spyOn(taskRepository, "markTaskFailed").mockResolvedValue(null);
    const createTaskSpy = spyOn(taskRepository, "createTask").mockResolvedValue({} as any);
    const updateStatusSpy = spyOn(projectRepository, "updateStatus").mockResolvedValue(undefined as any);

    await (worker as any).handleTaskFailure({
      id: "task-1",
      project_ref: "proj-ref",
      task_type: "provision_realtime",
      status: "failed",
      payload: {},
      error: "boom",
      retries: 1,
      created_at: new Date(),
      updated_at: new Date(),
    });

    // Realtime is optional: failure continues the pipeline immediately regardless of retry budget
    expect(createTaskSpy).toHaveBeenCalledTimes(1);
    expect(createTaskSpy).toHaveBeenCalledWith("proj-ref", "provision_router");
    expect(markTaskFailedSpy).toHaveBeenCalledWith("task-1", "Task execution failed");
    expect(updateStatusSpy).not.toHaveBeenCalled();
  });

  test("provision failure with retries left schedules a retry instead of stalling", async () => {
    const task = failedTask();
    const worker = new TaskWorker();
    const workerHarness = worker as unknown as {
      handleTaskFailure(task: ProjectTask): Promise<void>;
    };
    const markTaskFailedSpy = spyOn(taskRepository, "markTaskFailed").mockResolvedValue(null);
    const scheduleRetrySpy = spyOn(taskRepository, "scheduleRetry").mockResolvedValue(task);
    const createTaskSpy = spyOn(taskRepository, "createTask").mockResolvedValue(task);
    const updateStatusSpy = spyOn(projectRepository, "updateStatus").mockResolvedValue(null);
    const beforeRetry = Date.now();

    await workerHarness.handleTaskFailure(task);

    expect(scheduleRetrySpy).toHaveBeenCalledTimes(1);
    expect(scheduleRetrySpy.mock.calls[0][0]).toBe("task-retry-1");
    expect(scheduleRetrySpy.mock.calls[0][1]).toBe("Task execution failed");
    expect(scheduleRetrySpy.mock.calls[0][2].getTime()).toBeGreaterThanOrEqual(beforeRetry + 5_000);
    expect(scheduleRetrySpy.mock.calls[0][2].getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
    // Must not trigger saga compensation while retries remain
    expect(markTaskFailedSpy).not.toHaveBeenCalled();
    expect(createTaskSpy).not.toHaveBeenCalled();
    expect(updateStatusSpy).not.toHaveBeenCalled();
  });

  test("retryable poll failure transitions directly to retry_scheduled", async () => {
    const task = failedTask();
    const worker = new TaskWorker();
    const workerHarness = worker as unknown as {
      isRunning: boolean;
      poll(): Promise<void>;
      executeTask(task: ProjectTask): Promise<boolean>;
    };
    workerHarness.isRunning = true;

    spyOn(taskRepository, "claimNextTask").mockResolvedValue(task);
    spyOn(taskRepository, "markTaskRunning").mockResolvedValue(task);
    const markTaskFailedSpy = spyOn(taskRepository, "markTaskFailed").mockResolvedValue(task);
    const scheduleRetrySpy = spyOn(taskRepository, "scheduleRetry").mockResolvedValue({
      ...task,
      status: TaskStatus.RETRY_SCHEDULED,
    });
    spyOn(workerHarness, "executeTask").mockResolvedValue(false);
    const broadcastTaskUpdateSpy = spyOn(wsModule, "broadcastTaskUpdate").mockImplementation(() => {});

    await workerHarness.poll();

    expect(markTaskFailedSpy).not.toHaveBeenCalled();
    expect(scheduleRetrySpy).toHaveBeenCalledTimes(1);
    expect(broadcastTaskUpdateSpy.mock.calls.map(([update]) => update.status)).toEqual([
      TaskStatus.RUNNING,
      TaskStatus.RETRY_SCHEDULED,
    ]);
  });

  test("provision_runtime failure still rolls back runtime, storage, and database", async () => {
    const worker = new TaskWorker();
    const markTaskFailedSpy = spyOn(taskRepository, "markTaskFailed").mockResolvedValue(null);
    const createTaskSpy = spyOn(taskRepository, "createTask").mockResolvedValue({} as any);
    const updateStatusSpy = spyOn(projectRepository, "updateStatus").mockResolvedValue(undefined as any);

    await (worker as any).handleTaskFailure({
      id: "task-2",
      project_ref: "proj-ref",
      task_type: "provision_runtime",
      status: "failed",
      payload: {},
      error: "boom",
      retries: 3,
      created_at: new Date(),
      updated_at: new Date(),
    });

    expect(markTaskFailedSpy).toHaveBeenCalledWith("task-2", "Task execution failed");
    expect(updateStatusSpy).toHaveBeenCalledWith("proj-ref", "paused");
    expect(createTaskSpy.mock.calls.map((call) => call[1])).toEqual([
      "cleanup_runtime",
      "cleanup_s3",
      "cleanup_db",
    ]);
  });
});

describe("TaskWorker cleanup_s3", () => {
  afterEach(() => {
    mock.restore();
  });

  test.each([
    ["successful", { success: true }, true],
    ["non-empty", { success: false, error: "Bucket is not empty" }, false],
    ["unknown", { success: false, error: "Bucket deletion outcome is unknown" }, false],
  ])("returns %s storage cleanup results without declaring a false success", async (
    _outcome,
    deletion,
    expected,
  ) => {
    const originalFixedJwtSecret = process.env.TEST_FIXED_JWT_SECRET;
    delete process.env.TEST_FIXED_JWT_SECRET;
    const worker = new TaskWorker();
    const deleteBucketSpy = spyOn(storageService, "deleteBucket").mockResolvedValue(deletion);
    spyOn(projectRepository, "findByRef").mockResolvedValue(null);

    try {
      const completed = await (worker as any).executeTask({
        id: "cleanup-s3-task",
        project_ref: "proj-ref",
        task_type: "cleanup_s3",
        payload: {},
      });

      expect(completed).toBe(expected);
      expect(deleteBucketSpy).toHaveBeenCalledWith("proj-ref");
    } finally {
      if (originalFixedJwtSecret === undefined) delete process.env.TEST_FIXED_JWT_SECRET;
      else process.env.TEST_FIXED_JWT_SECRET = originalFixedJwtSecret;
    }
  });
});

describe("TaskWorker provision_secrets", () => {
  afterEach(() => {
    mock.restore();
  });

  test("repairs invalid service role keys and injects internal runtime SupaCloud variables", async () => {
    const worker = new TaskWorker();
    const upsertSecretSpy = spyOn(databaseService, "upsertSecret").mockResolvedValue(true);
    spyOn(databaseService, "getSecrets").mockResolvedValue([]);
    const generateServiceRoleKeySpy = spyOn(jwtService, "generateServiceRoleKey")
      .mockResolvedValue("generated.service.role");
    let storedProject = {
      ref: "proj-ref",
      name: "proj",
      db_name: "proj_ref",
      db_user: "postgres",
      db_password: "dbpass",
      jwt_secret: "test-jwt-secret-with-enough-length",
      anon_key: "header.payload.signature",
      service_role_key: "not-a-jwt",
      s3_bucket: "proj-ref",
      s3_access_key: null,
      s3_secret_key: null,
      region: "local",
      status: "active",
      config: { custom_domain: "app.example.com" },
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null,
    } as any;
    spyOn(projectRepository, "findByRef").mockImplementation(async () => storedProject);
    const updateApiKeysSpy = spyOn(projectRepository, "updateApiKeys").mockImplementation(async (
      _ref,
      keys,
    ) => {
      storedProject = { ...storedProject, ...keys };
      return storedProject;
    });

    const ok = await (worker as any).executeTask({
      id: "task-1",
      project_ref: "proj-ref",
      task_type: "provision_secrets",
      payload: {},
    });

    expect(ok).toBe(true);
    expect(generateServiceRoleKeySpy).toHaveBeenCalledWith("test-jwt-secret-with-enough-length");
    expect(updateApiKeysSpy).toHaveBeenCalledWith("proj-ref", {
      jwt_secret: "test-jwt-secret-with-enough-length",
      anon_key: "header.payload.signature",
      service_role_key: "generated.service.role",
    });

    const secrets = new Map(upsertSecretSpy.mock.calls.map((call) => [call[1], call[2]]));
    expect(secrets.get("SUPABASE_SERVICE_ROLE_KEY")).toMatch(/^[^.]+\.[^.]+\.[^.]+$/);
    expect(secrets.get("SUPACLOUD_INTERNAL_SUPABASE_URL")).toBe("http://127.0.0.1");
    expect(secrets.get("SUPACLOUD_INTERNAL_AUTH_URL")).toBe("http://127.0.0.1/auth/v1");
    expect(secrets.get("SUPACLOUD_INTERNAL_REST_URL")).toBe("http://127.0.0.1/rest/v1");
    expect(secrets.get("SUPACLOUD_PROJECT_REF")).toBe("proj-ref");
    expect(secrets.get("SUPACLOUD_PROJECT_API_HOST")).toBe("api.app.example.com");
    expect(secrets.get("X_PROJECT_REF")).toBe("proj-ref");
  });
});

describe("TaskWorker project activation", () => {
  afterEach(() => {
    mock.restore();
  });

  test("uses the guarded creating to active transition after provisioning", async () => {
    const worker = new TaskWorker();
    const activateSpy = spyOn(projectRepository, "activateCreatingProject")
      .mockResolvedValue({ ref: "proj-ref" } as never);

    await (worker as any).handleTaskCompletion({
      project_ref: "proj-ref",
      task_type: "provision_secrets",
    });

    expect(activateSpy).toHaveBeenCalledWith("proj-ref");
  });
});
