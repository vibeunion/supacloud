import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { TaskStatus } from "../../src/db";

const listTasksByProjectFiltered = mock(() => Promise.resolve([]));
const getTaskById = mock(() => Promise.resolve(null));
const listTaskAttempts = mock(() => Promise.resolve([]));
const cancelTask = mock(() => Promise.resolve(null));
const retryTask = mock(() => Promise.resolve(null));
const requestTaskCancellation = mock(() => Promise.resolve(null));
const getTaskStats = mock(() => Promise.resolve({
  running: 0,
  retryScheduled: 0,
  deadLettered: 0,
  failedLast24h: 0,
  cancelledLast24h: 0,
  topFailures: [],
  failedTrend: [],
}));

const backgroundFunctionWorker = {
  cancel: mock(() => Promise.resolve(true)),
};

const projectService = {
  getBackgroundTaskSettings: mock(() => Promise.resolve({
    concurrency: 2,
    max_attempts: 3,
    max_payload_bytes: 262144,
    timeout_sec_default: 300,
    timeout_sec_max: 900,
  })),
  updateBackgroundTaskSettings: mock(() => Promise.resolve({
    concurrency: 4,
    max_attempts: 5,
    max_payload_bytes: 524288,
    timeout_sec_default: 300,
    timeout_sec_max: 900,
  })),
};

const { taskRepository } = await import("../../src/repositories/task.repository");
const services = await import("../../src/services");

spyOn(taskRepository, "listTasksByProjectFiltered").mockImplementation(
  listTasksByProjectFiltered as typeof taskRepository.listTasksByProjectFiltered,
);
spyOn(taskRepository, "getTaskById").mockImplementation(getTaskById as typeof taskRepository.getTaskById);
spyOn(taskRepository, "listTaskAttempts").mockImplementation(
  listTaskAttempts as typeof taskRepository.listTaskAttempts,
);
spyOn(taskRepository, "cancelTask").mockImplementation(cancelTask as typeof taskRepository.cancelTask);
spyOn(taskRepository, "retryTask").mockImplementation(retryTask as typeof taskRepository.retryTask);
spyOn(taskRepository, "requestTaskCancellation").mockImplementation(
  requestTaskCancellation as typeof taskRepository.requestTaskCancellation,
);
spyOn(taskRepository, "getTaskStats").mockImplementation(getTaskStats as typeof taskRepository.getTaskStats);
spyOn(services.backgroundFunctionWorker, "cancel").mockImplementation(
  backgroundFunctionWorker.cancel as typeof services.backgroundFunctionWorker.cancel,
);
spyOn(services.projectService, "getBackgroundTaskSettings").mockImplementation(
  projectService.getBackgroundTaskSettings as typeof services.projectService.getBackgroundTaskSettings,
);
spyOn(services.projectService, "updateBackgroundTaskSettings").mockImplementation(
  projectService.updateBackgroundTaskSettings as typeof services.projectService.updateBackgroundTaskSettings,
);

const { taskRoutes } = await import("../../src/routes/tasks");

const app = new Elysia().use(taskRoutes);

function request(path: string, init?: RequestInit) {
  return app.handle(new Request(`http://localhost${path}`, init));
}

describe("taskRoutes", () => {
  beforeEach(() => {
    listTasksByProjectFiltered.mockReset();
    getTaskById.mockReset();
    listTaskAttempts.mockReset();
    cancelTask.mockReset();
    retryTask.mockReset();
    requestTaskCancellation.mockReset();
    getTaskStats.mockReset();
    backgroundFunctionWorker.cancel.mockReset();
    projectService.getBackgroundTaskSettings.mockReset();
    projectService.updateBackgroundTaskSettings.mockReset();

    backgroundFunctionWorker.cancel.mockResolvedValue(true);
  });

  test("GET /v1/projects/:ref/tasks forwards function_slug filter to repository", async () => {
    listTasksByProjectFiltered.mockResolvedValueOnce([
      { id: "tsk_1", function_slug: "mockup-generator", status: "running" },
    ]);

    const response = await request(
      "/v1/projects/proj_1/tasks?function_slug=mockup-generator&limit=8",
    );

    expect(response.status).toBe(200);
    expect(listTasksByProjectFiltered).toHaveBeenCalledWith("proj_1", {
      statuses: undefined,
      taskTypes: undefined,
      functionSlug: "mockup-generator",
      onlyDeadLettered: false,
      limit: 8,
    });
  });

  test("static task routes win over dynamic :taskId route", async () => {
    projectService.getBackgroundTaskSettings.mockResolvedValueOnce({
      concurrency: 2,
      max_attempts: 3,
      max_payload_bytes: 262144,
      timeout_sec_default: 300,
      timeout_sec_max: 900,
    });

    const response = await request("/v1/projects/proj_1/tasks/settings/background");

    expect(response.status).toBe(200);
    expect(projectService.getBackgroundTaskSettings).toHaveBeenCalledWith("proj_1");
    expect(getTaskById).not.toHaveBeenCalled();
  });

  test("GET /stats returns stats payload", async () => {
    getTaskStats.mockResolvedValueOnce({
      running: 1,
      retryScheduled: 2,
      deadLettered: 3,
      failedLast24h: 4,
      cancelledLast24h: 5,
      topFailures: [{ message: "boom", count: 2 }],
      failedTrend: [{ bucket: "04-17 09:00", failures: 1 }],
    });

    const response = await request("/v1/projects/proj_1/tasks/stats");
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.deadLettered).toBe(3);
    expect(getTaskStats).toHaveBeenCalledWith("proj_1");
  });

  test("POST /:taskId/cancel triggers runtime cancellation for running tasks", async () => {
    getTaskById.mockResolvedValueOnce({
      id: "tsk_running",
      status: TaskStatus.RUNNING,
      project_ref: "proj_1",
    }).mockResolvedValueOnce({
      id: "tsk_running",
      status: TaskStatus.RUNNING,
      cancel_requested_at: "2026-04-17T12:00:00.000Z",
    });

    const response = await request("/v1/projects/proj_1/tasks/tsk_running/cancel", {
      method: "POST",
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(backgroundFunctionWorker.cancel).toHaveBeenCalledWith("tsk_running");
    expect(cancelTask).not.toHaveBeenCalled();
    expect(payload.cancel_requested_at).toBe("2026-04-17T12:00:00.000Z");
  });

  test("POST /:taskId/cancel skips runtime cancellation for non-running tasks", async () => {
    getTaskById.mockResolvedValueOnce({
      id: "tsk_done",
      status: TaskStatus.PENDING,
      project_ref: "proj_1",
    }).mockResolvedValueOnce({
      id: "tsk_done",
      status: TaskStatus.CANCELLED,
    });
    backgroundFunctionWorker.cancel.mockResolvedValueOnce(true);

    const response = await request("/v1/projects/proj_1/tasks/tsk_done/cancel", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(backgroundFunctionWorker.cancel).toHaveBeenCalledWith("tsk_done");
  });

  test("POST /:taskId/cancel returns 409 for terminal tasks", async () => {
    getTaskById.mockResolvedValueOnce({
      id: "tsk_done",
      status: TaskStatus.SUCCEEDED,
      project_ref: "proj_1",
    });

    const response = await request("/v1/projects/proj_1/tasks/tsk_done/cancel", {
      method: "POST",
    });

    expect(response.status).toBe(409);
    expect(backgroundFunctionWorker.cancel).not.toHaveBeenCalled();
    expect(cancelTask).not.toHaveBeenCalled();
  });

  test("GET /:taskId returns attempts and latest_logs", async () => {
    getTaskById.mockResolvedValueOnce({
      id: "tsk_1",
      status: "dead_lettered",
      project_ref: "proj_1",
      function_slug: "mockup-generator",
    });
    listTaskAttempts.mockResolvedValueOnce([
      {
        attempt_no: 2,
        logs: [{ timestamp: "2026-04-17T12:00:00.000Z", stream: "stderr", level: "error", message: "boom" }],
      },
      {
        attempt_no: 1,
        logs: [],
      },
    ]);

    const response = await request("/v1/projects/proj_1/tasks/tsk_1");
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.attempts).toHaveLength(2);
    expect(payload.latest_logs).toEqual([
      { timestamp: "2026-04-17T12:00:00.000Z", stream: "stderr", level: "error", message: "boom" },
    ]);
  });

  afterAll(() => {
    mock.restore();
  });
});
