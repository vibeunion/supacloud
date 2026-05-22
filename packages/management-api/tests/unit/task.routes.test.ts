import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { TaskStatus } from "../../src/db";
import { DEFAULT_BACKGROUND_TASK_SETTINGS } from "../../src/config/background-task-settings";

const listTasksByProjectFiltered = mock(() => Promise.resolve([]));
const getTaskById = mock(() => Promise.resolve(null));
const getTaskByIdAndType = mock(() => Promise.resolve(null));
const listTaskAttempts = mock(() => Promise.resolve([]));
const createTask = mock(() => Promise.resolve(null));
const claimQueueMessage = mock(() => Promise.resolve(null));
const acknowledgeQueueMessage = mock(() => Promise.resolve(null));
const releaseTask = mock(() => Promise.resolve(null));
const markTaskFailed = mock(() => Promise.resolve(null));
const cancelTask = mock(() => Promise.resolve(null));
const retryTask = mock(() => Promise.resolve(null));
const retryQueueMessage = mock(() => Promise.resolve(null));
const countQueueMessagesCreatedSince = mock(() => Promise.resolve(0));
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
const getQueueStats = mock(() => Promise.resolve({
  pending: 0,
  leased: 0,
  running: 0,
  retryScheduled: 0,
  succeededLast24h: 0,
  failedLast24h: 0,
  deadLettered: 0,
  oldestPendingAgeSec: null,
  inFlight: 0,
}));

const backgroundFunctionWorker = {
  cancel: mock(() => Promise.resolve(true)),
};

const projectService = {
  getBackgroundTaskSettings: mock(() => Promise.resolve({
    ...DEFAULT_BACKGROUND_TASK_SETTINGS,
  })),
  updateBackgroundTaskSettings: mock(() => Promise.resolve({
    concurrency: 4,
    max_attempts: 5,
    max_payload_bytes: 524288,
    timeout_sec_default: 300,
    timeout_sec_max: 900,
  })),
  getQueueSettings: mock(() => Promise.resolve({
    max_in_flight: 10,
    default_visibility_timeout_sec: 330,
    max_attempts: 3,
    rate_limit_per_minute: 600,
  })),
  updateQueueSettings: mock(() => Promise.resolve({
    max_in_flight: 20,
    default_visibility_timeout_sec: 120,
    max_attempts: 5,
    rate_limit_per_minute: 1200,
  })),
};

const { taskRepository } = await import("../../src/repositories/task.repository");
const services = await import("../../src/services");
const authModule = await import("../../src/middleware/auth");

spyOn(taskRepository, "listTasksByProjectFiltered").mockImplementation(
  listTasksByProjectFiltered as typeof taskRepository.listTasksByProjectFiltered,
);
spyOn(taskRepository, "getTaskById").mockImplementation(getTaskById as typeof taskRepository.getTaskById);
spyOn(taskRepository, "getTaskByIdAndType").mockImplementation(getTaskByIdAndType as typeof taskRepository.getTaskByIdAndType);
spyOn(taskRepository, "listTaskAttempts").mockImplementation(
  listTaskAttempts as typeof taskRepository.listTaskAttempts,
);
spyOn(taskRepository, "createTask").mockImplementation(createTask as typeof taskRepository.createTask);
spyOn(taskRepository, "claimQueueMessage").mockImplementation(claimQueueMessage as typeof taskRepository.claimQueueMessage);
spyOn(taskRepository, "acknowledgeQueueMessage").mockImplementation(acknowledgeQueueMessage as typeof taskRepository.acknowledgeQueueMessage);
spyOn(taskRepository, "releaseTask").mockImplementation(releaseTask as typeof taskRepository.releaseTask);
spyOn(taskRepository, "markTaskFailed").mockImplementation(markTaskFailed as typeof taskRepository.markTaskFailed);
spyOn(taskRepository, "cancelTask").mockImplementation(cancelTask as typeof taskRepository.cancelTask);
spyOn(taskRepository, "retryTask").mockImplementation(retryTask as typeof taskRepository.retryTask);
spyOn(taskRepository, "retryQueueMessage").mockImplementation(retryQueueMessage as typeof taskRepository.retryQueueMessage);
spyOn(taskRepository, "countQueueMessagesCreatedSince").mockImplementation(
  countQueueMessagesCreatedSince as typeof taskRepository.countQueueMessagesCreatedSince,
);
spyOn(taskRepository, "requestTaskCancellation").mockImplementation(
  requestTaskCancellation as typeof taskRepository.requestTaskCancellation,
);
spyOn(taskRepository, "getTaskStats").mockImplementation(getTaskStats as typeof taskRepository.getTaskStats);
spyOn(taskRepository, "getQueueStats").mockImplementation(getQueueStats as typeof taskRepository.getQueueStats);
spyOn(services.backgroundFunctionWorker, "cancel").mockImplementation(
  backgroundFunctionWorker.cancel as typeof services.backgroundFunctionWorker.cancel,
);
spyOn(services.projectService, "getBackgroundTaskSettings").mockImplementation(
  projectService.getBackgroundTaskSettings as typeof services.projectService.getBackgroundTaskSettings,
);
spyOn(services.projectService, "updateBackgroundTaskSettings").mockImplementation(
  projectService.updateBackgroundTaskSettings as typeof services.projectService.updateBackgroundTaskSettings,
);
spyOn(services.projectService, "getQueueSettings").mockImplementation(
  projectService.getQueueSettings as typeof services.projectService.getQueueSettings,
);
spyOn(services.projectService, "updateQueueSettings").mockImplementation(
  projectService.updateQueueSettings as typeof services.projectService.updateQueueSettings,
);

const verifyProjectJwt = mock(() => Promise.resolve(null));
spyOn(authModule, "verifyProjectJwt").mockImplementation(
  verifyProjectJwt as typeof authModule.verifyProjectJwt,
);

const { taskRoutes } = await import("../../src/routes/tasks");

const app = new Elysia().use(taskRoutes);

const authHeaders = { Authorization: "Bearer dev-master-token" };

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(authHeaders)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return app.handle(new Request(`http://localhost${path}`, { ...init, headers }));
}

describe("taskRoutes", () => {
  beforeEach(() => {
    listTasksByProjectFiltered.mockReset();
    getTaskById.mockReset();
    getTaskByIdAndType.mockReset();
    listTaskAttempts.mockReset();
    createTask.mockReset();
    claimQueueMessage.mockReset();
    acknowledgeQueueMessage.mockReset();
    releaseTask.mockReset();
    markTaskFailed.mockReset();
    cancelTask.mockReset();
    retryTask.mockReset();
    retryQueueMessage.mockReset();
    countQueueMessagesCreatedSince.mockReset();
    requestTaskCancellation.mockReset();
    getTaskStats.mockReset();
    getQueueStats.mockReset();
    backgroundFunctionWorker.cancel.mockReset();
    verifyProjectJwt.mockReset();
    verifyProjectJwt.mockResolvedValue(null);
    projectService.getBackgroundTaskSettings.mockReset();
    projectService.updateBackgroundTaskSettings.mockReset();
    projectService.getQueueSettings.mockReset();
    projectService.updateQueueSettings.mockReset();

    backgroundFunctionWorker.cancel.mockResolvedValue(true);
    projectService.getQueueSettings.mockResolvedValue({
      max_in_flight: 10,
      default_visibility_timeout_sec: 330,
      max_attempts: 3,
      rate_limit_per_minute: 600,
    });
    projectService.updateQueueSettings.mockResolvedValue({
      max_in_flight: 20,
      default_visibility_timeout_sec: 120,
      max_attempts: 5,
      rate_limit_per_minute: 1200,
    });
    countQueueMessagesCreatedSince.mockResolvedValue(0);
  });

  test("POST /queues/:queueName/messages enqueues a JSON message", async () => {
    createTask.mockResolvedValueOnce({ id: "msg_1", task_type: "queue:emails", status: "pending" });

    const response = await request("/v1/projects/proj_1/tasks/queues/emails/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { hello: "world" }, delayMs: 1000, maxAttempts: 5 }),
    });
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload.id).toBe("msg_1");
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      ref: "proj_1",
      type: "queue:emails",
      payload: { hello: "world" },
      maxAttempts: 5,
    }));
    expect(countQueueMessagesCreatedSince).toHaveBeenCalledWith(
      "proj_1",
      "queue:emails",
      expect.any(Date),
    );
  });

  test("POST /queues/:queueName/messages enforces queue rate limit", async () => {
    projectService.getQueueSettings.mockResolvedValueOnce({
      max_in_flight: 10,
      default_visibility_timeout_sec: 330,
      max_attempts: 3,
      rate_limit_per_minute: 1,
    });
    countQueueMessagesCreatedSince.mockResolvedValueOnce(1);

    const response = await request("/v1/projects/proj_1/tasks/queues/crawl/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { url: "https://example.com" } }),
    });
    const payload = await response.json();

    expect(response.status).toBe(429);
    expect(payload.message).toBe("Queue rate limit exceeded");
    expect(createTask).not.toHaveBeenCalled();
  });

  test("POST /queues/:queueName/messages/receive leases the next available message", async () => {
    claimQueueMessage.mockResolvedValueOnce({ id: "msg_1", task_type: "queue:emails", status: "leased" });

    const response = await request("/v1/projects/proj_1/tasks/queues/emails/messages/receive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visibilityTimeoutSec: 60 }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.id).toBe("msg_1");
    expect(claimQueueMessage).toHaveBeenCalledWith({
      projectRef: "proj_1",
      queueName: "queue:emails",
      visibilityTimeoutSec: 60,
      maxInFlight: 10,
    });
  });

  test("POST /queues/:queueName/messages/receive returns 204 when empty", async () => {
    claimQueueMessage.mockResolvedValueOnce(null);

    const response = await request("/v1/projects/proj_1/tasks/queues/emails/messages/receive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(204);
  });

  test("POST /queues/:queueName/messages/:messageId/ack acknowledges a leased message", async () => {
    getTaskByIdAndType.mockResolvedValueOnce({ id: "msg_1", task_type: "queue:emails", status: "leased" });
    acknowledgeQueueMessage.mockResolvedValueOnce({ id: "msg_1", task_type: "queue:emails", status: "succeeded" });

    const response = await request("/v1/projects/proj_1/tasks/queues/emails/messages/msg_1/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ result: { ok: true } }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.status).toBe("succeeded");
    expect(acknowledgeQueueMessage).toHaveBeenCalledWith("msg_1", { ok: true });
  });

  test("GET /queues/:queueName/messages lists only that queue", async () => {
    listTasksByProjectFiltered.mockResolvedValueOnce([
      { id: "msg_1", task_type: "queue:emails", status: "dead_lettered" },
    ]);

    const response = await request("/v1/projects/proj_1/tasks/queues/emails/messages?dlq=true&limit=5");

    expect(response.status).toBe(200);
    expect(listTasksByProjectFiltered).toHaveBeenCalledWith("proj_1", {
      statuses: undefined,
      taskTypes: ["queue:emails"],
      onlyDeadLettered: true,
      limit: 5,
    });
  });

  test("GET /queues/:queueName/stats returns queue-level metrics", async () => {
    getQueueStats.mockResolvedValueOnce({
      pending: 4,
      leased: 1,
      running: 0,
      retryScheduled: 2,
      succeededLast24h: 8,
      failedLast24h: 1,
      deadLettered: 3,
      oldestPendingAgeSec: 42,
      inFlight: 1,
    });

    const response = await request("/v1/projects/proj_1/tasks/queues/crawl/stats");
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.pending).toBe(4);
    expect(getQueueStats).toHaveBeenCalledWith("proj_1", "queue:crawl");
  });

  test("PATCH /queues/:queueName/settings updates queue reliability controls", async () => {
    const response = await request("/v1/projects/proj_1/tasks/queues/crawl/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_in_flight: 20,
        default_visibility_timeout_sec: 120,
        max_attempts: 5,
        rate_limit_per_minute: 1200,
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.max_in_flight).toBe(20);
    expect(projectService.updateQueueSettings).toHaveBeenCalledWith("proj_1", "crawl", {
      max_in_flight: 20,
      default_visibility_timeout_sec: 120,
      max_attempts: 5,
      rate_limit_per_minute: 1200,
    });
  });

  test("DELETE /queues/:queueName/messages/:messageId marks queue message deleted", async () => {
    getTaskByIdAndType.mockResolvedValueOnce({ id: "msg_1", task_type: "queue:emails", status: "leased" });
    cancelTask.mockResolvedValueOnce({ id: "msg_1", status: "cancelled" });

    const response = await request("/v1/projects/proj_1/tasks/queues/emails/messages/msg_1", {
      method: "DELETE",
    });

    expect(response.status).toBe(204);
    expect(cancelTask).toHaveBeenCalledWith("msg_1", "Deleted by queue client");
  });

  test("POST /queues/:queueName/messages/:messageId/retry replays DLQ messages", async () => {
    retryQueueMessage.mockResolvedValueOnce({ id: "msg_1", task_type: "queue:crawl", status: "pending" });

    const response = await request("/v1/projects/proj_1/tasks/queues/crawl/messages/msg_1/retry", {
      method: "POST",
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.status).toBe("pending");
    expect(retryQueueMessage).toHaveBeenCalledWith("msg_1", "proj_1", "queue:crawl");
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
      summary: false,
    });
  });

  test("GET /v1/projects/:ref/tasks forwards summary list mode to repository", async () => {
    listTasksByProjectFiltered.mockResolvedValueOnce([
      { id: "tsk_1", function_slug: "mockup-generator", status: "running" },
    ]);

    const response = await request(
      "/v1/projects/proj_1/tasks?function_slug=mockup-generator&limit=8&summary=true",
    );

    expect(response.status).toBe(200);
    expect(listTasksByProjectFiltered).toHaveBeenCalledWith("proj_1", {
      statuses: undefined,
      taskTypes: undefined,
      functionSlug: "mockup-generator",
      onlyDeadLettered: false,
      limit: 8,
      summary: true,
    });
  });

  test("static task routes win over dynamic :taskId route", async () => {
    projectService.getBackgroundTaskSettings.mockResolvedValueOnce({
      ...DEFAULT_BACKGROUND_TASK_SETTINGS,
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

  test("GET /:taskId allows the invoking user JWT and redacts stored credentials", async () => {
    verifyProjectJwt.mockResolvedValue({
      role: "authenticated",
      ref: "proj_1",
      sub: "user_1",
    });
    getTaskById.mockResolvedValueOnce({
      id: "tsk_user",
      status: "succeeded",
      project_ref: "proj_1",
      payload: {
        auth: {
          invoker_user_id: "user_1",
          authorization: "enc:token",
          apikey: "enc:key",
        },
      },
    });
    listTaskAttempts.mockResolvedValueOnce([]);

    const response = await request("/v1/projects/proj_1/tasks/tsk_user", {
      headers: { Authorization: "Bearer user.jwt.token" },
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.payload.auth.invoker_user_id).toBe("user_1");
    expect(payload.payload.auth.authorization).toBeNull();
    expect(payload.payload.auth.apikey).toBeNull();
  });

  test("GET /:taskId rejects authenticated users that did not invoke the task", async () => {
    verifyProjectJwt.mockResolvedValue({
      role: "authenticated",
      ref: "proj_1",
      sub: "user_2",
    });
    getTaskById.mockResolvedValueOnce({
      id: "tsk_user",
      status: "succeeded",
      project_ref: "proj_1",
      payload: {
        auth: {
          invoker_user_id: "user_1",
        },
      },
    });

    const response = await request("/v1/projects/proj_1/tasks/tsk_user", {
      headers: { Authorization: "Bearer user.jwt.token" },
    });

    expect(response.status).toBe(403);
    expect(listTaskAttempts).not.toHaveBeenCalled();
  });

  afterAll(() => {
    mock.restore();
  });
});
