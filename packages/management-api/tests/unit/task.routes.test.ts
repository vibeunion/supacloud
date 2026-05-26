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
const pgmqCreateQueue = mock(() => Promise.resolve(undefined));
const pgmqListQueues = mock(() => Promise.resolve([]));
const pgmqListMessages = mock(() => Promise.resolve([]));
const pgmqSend = mock(() => Promise.resolve(1));
const pgmqSendBatch = mock(() => Promise.resolve([1, 2]));
const pgmqRead = mock(() => Promise.resolve([]));
const pgmqPop = mock(() => Promise.resolve(null));
const pgmqArchive = mock(() => Promise.resolve(true));
const pgmqDeleteMessage = mock(() => Promise.resolve(true));
const pgmqSetVisibilityTimeout = mock(() => Promise.resolve(null));
const pgmqMetrics = mock(() => Promise.resolve(null));

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
const { pgmqService } = await import("../../src/services/pgmq.service");
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
spyOn(pgmqService, "createQueue").mockImplementation(pgmqCreateQueue as typeof pgmqService.createQueue);
spyOn(pgmqService, "listQueues").mockImplementation(pgmqListQueues as typeof pgmqService.listQueues);
spyOn(pgmqService, "listMessages").mockImplementation(pgmqListMessages as typeof pgmqService.listMessages);
spyOn(pgmqService, "send").mockImplementation(pgmqSend as typeof pgmqService.send);
spyOn(pgmqService, "sendBatch").mockImplementation(pgmqSendBatch as typeof pgmqService.sendBatch);
spyOn(pgmqService, "read").mockImplementation(pgmqRead as typeof pgmqService.read);
spyOn(pgmqService, "pop").mockImplementation(pgmqPop as typeof pgmqService.pop);
spyOn(pgmqService, "archive").mockImplementation(pgmqArchive as typeof pgmqService.archive);
spyOn(pgmqService, "deleteMessage").mockImplementation(pgmqDeleteMessage as typeof pgmqService.deleteMessage);
spyOn(pgmqService, "setVisibilityTimeout").mockImplementation(
  pgmqSetVisibilityTimeout as typeof pgmqService.setVisibilityTimeout,
);
spyOn(pgmqService, "metrics").mockImplementation(pgmqMetrics as typeof pgmqService.metrics);

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
    pgmqCreateQueue.mockReset();
    pgmqListQueues.mockReset();
    pgmqListMessages.mockReset();
    pgmqSend.mockReset();
    pgmqSendBatch.mockReset();
    pgmqRead.mockReset();
    pgmqPop.mockReset();
    pgmqArchive.mockReset();
    pgmqDeleteMessage.mockReset();
    pgmqSetVisibilityTimeout.mockReset();
    pgmqMetrics.mockReset();

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
    pgmqCreateQueue.mockResolvedValue(undefined);
    pgmqListQueues.mockResolvedValue([]);
    pgmqListMessages.mockResolvedValue([]);
    pgmqSend.mockResolvedValue(1);
    pgmqSendBatch.mockResolvedValue([1, 2]);
    pgmqRead.mockResolvedValue([]);
    pgmqPop.mockResolvedValue(null);
    pgmqArchive.mockResolvedValue(true);
    pgmqDeleteMessage.mockResolvedValue(true);
    pgmqSetVisibilityTimeout.mockResolvedValue(null);
    pgmqMetrics.mockResolvedValue(null);
  });

  test("POST /queues/:queueName/messages enqueues a JSON message", async () => {
    pgmqSend.mockResolvedValueOnce(42);

    const response = await request("/v1/projects/proj_1/tasks/queues/emails/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload: { hello: "world" },
        delayMs: 1000,
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload.id).toBe("42");
    expect(payload.task_type).toBe("queue:emails");
    expect(pgmqSend).toHaveBeenCalledWith(
      "proj_1",
      "emails",
      { hello: "world" },
      1,
    );
  });

  test("POST /queues creates a PGMQ queue", async () => {
    const response = await request("/v1/projects/proj_1/tasks/queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queue_name: "emails", unlogged: true }),
    });
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload.queue_name).toBe("emails");
    expect(payload.type).toBe("unlogged");
    expect(pgmqCreateQueue).toHaveBeenCalledWith("proj_1", "emails", { unlogged: true });
  });

  test("POST /queues/:queueName/messages/batch sends JSON messages through PGMQ", async () => {
    pgmqSendBatch.mockResolvedValueOnce([7, 8]);

    const response = await request("/v1/projects/proj_1/tasks/queues/crawl/messages/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ a: 1 }, { b: 2 }], sleep_seconds: 30 }),
    });
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload.msg_ids).toEqual([7, 8]);
    expect(pgmqSendBatch).toHaveBeenCalledWith("proj_1", "crawl", [{ a: 1 }, { b: 2 }], 30);
  });

  test("POST /queues/:queueName/messages/receive leases the next available message", async () => {
    pgmqRead.mockResolvedValueOnce([{ id: "11", msg_id: 11, task_type: "queue:emails", status: "leased", payload: { hello: "world" } }]);

    const response = await request("/v1/projects/proj_1/tasks/queues/emails/messages/receive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visibilityTimeoutSec: 60 }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.id).toBe("11");
    expect(pgmqRead).toHaveBeenCalledWith("proj_1", "emails", 60, 1);
  });

  test("POST /queues/:queueName/messages/receive returns 204 when empty", async () => {
    pgmqRead.mockResolvedValueOnce([]);

    const response = await request("/v1/projects/proj_1/tasks/queues/emails/messages/receive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(204);
  });

  test("POST /queues/:queueName/messages/:messageId/ack acknowledges a leased message", async () => {
    pgmqArchive.mockResolvedValueOnce(true);

    const response = await request("/v1/projects/proj_1/tasks/queues/emails/messages/11/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ result: { ok: true } }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.status).toBe("archived");
    expect(pgmqArchive).toHaveBeenCalledWith("proj_1", "emails", 11);
  });

  test("POST /queues/:queueName/messages/pop deletes and returns next PGMQ message", async () => {
    pgmqPop.mockResolvedValueOnce({ id: "12", msg_id: 12, task_type: "queue:emails", status: "deleted", payload: { ok: true } });

    const response = await request("/v1/projects/proj_1/tasks/queues/emails/messages/pop", {
      method: "POST",
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.id).toBe("12");
    expect(pgmqPop).toHaveBeenCalledWith("proj_1", "emails");
  });

  test("GET /queues/:queueName/stats returns queue-level metrics", async () => {
    pgmqMetrics.mockResolvedValueOnce({
      queue_name: "crawl",
      queue_length: 4,
      newest_msg_age_sec: 3,
      oldest_msg_age_sec: 42,
      total_messages: 9,
      scrape_time: "2026-05-26T00:00:00Z",
    });

    const response = await request("/v1/projects/proj_1/tasks/queues/crawl/stats");
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.queue_length).toBe(4);
    expect(pgmqMetrics).toHaveBeenCalledWith("proj_1", "crawl");
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
    pgmqDeleteMessage.mockResolvedValueOnce(true);

    const response = await request("/v1/projects/proj_1/tasks/queues/emails/messages/11", {
      method: "DELETE",
    });

    expect(response.status).toBe(204);
    expect(pgmqDeleteMessage).toHaveBeenCalledWith("proj_1", "emails", 11);
  });

  test("POST /queues/:queueName/messages/:messageId/retry reports official PGMQ limitation", async () => {
    const response = await request("/v1/projects/proj_1/tasks/queues/crawl/messages/11/retry", {
      method: "POST",
    });
    const payload = await response.json();

    expect(response.status).toBe(410);
    expect(payload.message).toContain("official queue API");
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
