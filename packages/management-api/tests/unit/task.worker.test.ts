import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { taskRepository } from "../../src/repositories/task.repository";
import { projectRepository } from "../../src/repositories/project.repository";
import { TaskWorker } from "../../src/services/task.worker";
import { databaseService } from "../../src/services/database.service";
import { jwtService } from "../../src/services/jwt.service";

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
    const createTaskSpy = spyOn(taskRepository, "createTask").mockResolvedValue({} as any);
    const updateStatusSpy = spyOn(projectRepository, "updateStatus").mockResolvedValue(undefined as any);

    await (worker as any).handleTaskFailure({
      id: "task-1",
      project_ref: "proj-ref",
      task_type: "provision_realtime",
      status: "failed",
      payload: {},
      error: "boom",
      retries: 3,
      created_at: new Date(),
      updated_at: new Date(),
    });

    expect(createTaskSpy).toHaveBeenCalledTimes(1);
    expect(createTaskSpy).toHaveBeenCalledWith("proj-ref", "provision_router");
    expect(updateStatusSpy).not.toHaveBeenCalled();
  });

  test("provision_runtime failure still rolls back runtime, storage, and database", async () => {
    const worker = new TaskWorker();
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

    expect(updateStatusSpy).toHaveBeenCalledWith("proj-ref", "paused");
    expect(createTaskSpy.mock.calls.map((call) => call[1])).toEqual([
      "cleanup_runtime",
      "cleanup_s3",
      "cleanup_db",
    ]);
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
    spyOn(jwtService, "generateServiceRoleKey").mockResolvedValue("generated.service.role");
    const updateApiKeysSpy = spyOn(projectRepository, "updateApiKeys").mockResolvedValue({} as any);
    spyOn(projectRepository, "findByRef").mockResolvedValue({
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
    } as any);

    const ok = await (worker as any).executeTask({
      id: "task-1",
      project_ref: "proj-ref",
      task_type: "provision_secrets",
      payload: {},
    });

    expect(ok).toBe(true);
    expect(updateApiKeysSpy).toHaveBeenCalledTimes(1);

    const secrets = new Map(upsertSecretSpy.mock.calls.map((call) => [call[1], call[2]]));
    expect(secrets.get("SUPABASE_SERVICE_ROLE_KEY")).toMatch(/^[^.]+\.[^.]+\.[^.]+$/);
    expect(secrets.get("SUPACLOUD_INTERNAL_SUPABASE_URL")).toBe("http://127.0.0.1:9090");
    expect(secrets.get("SUPACLOUD_INTERNAL_AUTH_URL")).toBe("http://127.0.0.1:9090/auth/v1");
    expect(secrets.get("SUPACLOUD_INTERNAL_REST_URL")).toBe("http://127.0.0.1:9090/rest/v1");
    expect(secrets.get("SUPACLOUD_PROJECT_REF")).toBe("proj-ref");
    expect(secrets.get("SUPACLOUD_PROJECT_API_HOST")).toBe("api.app.example.com");
    expect(secrets.get("X_PROJECT_REF")).toBe("proj-ref");
  });
});
