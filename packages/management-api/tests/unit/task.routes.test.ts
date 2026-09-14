import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { TaskStatus } from "../../src/db";
import { DEFAULT_BACKGROUND_TASK_SETTINGS } from "../../src/config/background-task-settings";
import { taskAttemptFixture, taskFixture } from "../helpers/task-fixtures";
import type { PgmqMessage } from "../../src/services/pgmq.service";

const { taskRepository } = await import("../../src/repositories/task.repository");
const services = await import("../../src/services");
const { pgmqService } = await import("../../src/services/pgmq.service");
const authModule = await import("../../src/middleware/auth");

const listTasksByProjectFiltered = spyOn(taskRepository, "listTasksByProjectFiltered").mockResolvedValue([]);
const getTaskById = spyOn(taskRepository, "getTaskById").mockResolvedValue(null);
const getTaskByIdAndType = spyOn(taskRepository, "getTaskByIdAndType").mockResolvedValue(null);
const listTaskAttempts = spyOn(taskRepository, "listTaskAttempts").mockResolvedValue([]);
const createTask = spyOn(taskRepository, "createTask").mockImplementation(async () => taskFixture());
const claimQueueMessage = spyOn(taskRepository, "claimQueueMessage").mockResolvedValue(null);
const acknowledgeQueueMessage = spyOn(taskRepository, "acknowledgeQueueMessage").mockResolvedValue(null);
const releaseTask = spyOn(taskRepository, "releaseTask").mockResolvedValue(null);
const markTaskFailed = spyOn(taskRepository, "markTaskFailed").mockResolvedValue(null);
const cancelTask = spyOn(taskRepository, "cancelTask").mockResolvedValue(null);
const retryTask = spyOn(taskRepository, "retryTask").mockResolvedValue(null);
const retryQueueMessage = spyOn(taskRepository, "retryQueueMessage").mockResolvedValue(null);
const countQueueMessagesCreatedSince = spyOn(taskRepository, "countQueueMessagesCreatedSince").mockResolvedValue(0);
const requestTaskCancellation = spyOn(taskRepository, "requestTaskCancellation").mockResolvedValue(null);
const getTaskStats = spyOn(taskRepository, "getTaskStats").mockResolvedValue({
  running: 0,
  retryScheduled: 0,
  deadLettered: 0,
  failedLast24h: 0,
  cancelledLast24h: 0,
  topFailures: [],
  failedTrend: [],
});
const getQueueStats = spyOn(taskRepository, "getQueueStats").mockResolvedValue({
  pending: 0,
  leased: 0,
  running: 0,
  retryScheduled: 0,
  succeededLast24h: 0,
  failedLast24h: 0,
  deadLettered: 0,
  oldestPendingAgeSec: null,
  inFlight: 0,
});
const pgmqCreateQueue = spyOn(pgmqService, "createQueue").mockResolvedValue(undefined);
const pgmqListQueues = spyOn(pgmqService, "listQueues").mockResolvedValue([]);
const pgmqListMessages = spyOn(pgmqService, "listMessages").mockResolvedValue([]);
const pgmqSend = spyOn(pgmqService, "send").mockResolvedValue("1");
const pgmqSendBatch = spyOn(pgmqService, "sendBatch").mockResolvedValue(["1", "2"]);
const pgmqRead = spyOn(pgmqService, "read").mockResolvedValue([]);
const pgmqPop = spyOn(pgmqService, "pop").mockResolvedValue(null);
const pgmqArchive = spyOn(pgmqService, "archive").mockResolvedValue(true);
const pgmqDeleteMessage = spyOn(pgmqService, "deleteMessage").mockResolvedValue(true);
const pgmqSetVisibilityTimeout = spyOn(pgmqService, "setVisibilityTimeout").mockResolvedValue(null);
const pgmqMetrics = spyOn(pgmqService, "metrics").mockResolvedValue(null);

const backgroundFunctionWorker = {
  cancel: spyOn(services.backgroundFunctionWorker, "cancel").mockResolvedValue(true),
};

const projectService = {
  getBackgroundTaskSettings: spyOn(services.projectService, "getBackgroundTaskSettings").mockResolvedValue({
    ...DEFAULT_BACKGROUND_TASK_SETTINGS,
  }),
  updateBackgroundTaskSettings: spyOn(services.projectService, "updateBackgroundTaskSettings").mockResolvedValue({
    concurrency: 4,
    max_attempts: 5,
    max_payload_bytes: 524288,
    timeout_sec_default: 300,
    timeout_sec_max: 900,
  }),
  getQueueSettings: spyOn(services.projectService, "getQueueSettings").mockResolvedValue({
    max_in_flight: 10,
    default_visibility_timeout_sec: 330,
    max_attempts: 3,
    rate_limit_per_minute: 600,
  }),
  updateQueueSettings: spyOn(services.projectService, "updateQueueSettings").mockResolvedValue({
    max_in_flight: 20,
    default_visibility_timeout_sec: 120,
    max_attempts: 5,
    rate_limit_per_minute: 1200,
  }),
};

const verifyProjectJwt = spyOn(authModule, "verifyProjectJwt").mockResolvedValue(null);

const { taskRoutes } = await import("../../src/routes/tasks");

const app = new Elysia().use(taskRoutes);

const authHeaders = { Authorization: "Bearer dev-master-token" };

function queueMessageFixture(overrides: Partial<PgmqMessage> = {}): PgmqMessage {
  return {
    id: "1", msg_id: "1", task_type: "queue:emails", status: "leased", payload: {}, message: {},
    enqueued_at: new Date(0), vt: new Date(60_000), read_ct: 1, ...overrides,
  };
}

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
    pgmqSend.mockResolvedValue("1");
    pgmqSendBatch.mockResolvedValue(["1", "2"]);
    pgmqRead.mockResolvedValue([]);
    pgmqPop.mockResolvedValue(null);
    pgmqArchive.mockResolvedValue(true);
    pgmqDeleteMessage.mockResolvedValue(true);
    pgmqSetVisibilityTimeout.mockResolvedValue(null);
    pgmqMetrics.mockResolvedValue(null);
  });

  test("POST /queues/:queueName/messages enqueues a JSON message", async () => {
    pgmqSend.mockResolvedValueOnce("42");

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

  test("reserves SupaCloud internal queues from management API callers", async () => {
    const createResponse = await request("/v1/projects/proj_1/tasks/queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queue_name: "supacloud_internal_workflows" }),
    });
    const sendResponse = await request(
      "/v1/projects/proj_1/tasks/queues/supacloud_internal_workflows/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: { rejected: true } }),
      },
    );

    expect(createResponse.status).toBe(400);
    expect(sendResponse.status).toBe(400);
    expect(pgmqCreateQueue).not.toHaveBeenCalled();
    expect(pgmqSend).not.toHaveBeenCalled();
  });

  test("POST /queues/:queueName/messages/batch sends JSON messages through PGMQ", async () => {
    pgmqSendBatch.mockResolvedValueOnce(["7", "8"]);

    const response = await request("/v1/projects/proj_1/tasks/queues/crawl/messages/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ a: 1 }, { b: 2 }], sleep_seconds: 30 }),
    });
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload.msg_ids).toEqual(["7", "8"]);
    expect(pgmqSendBatch).toHaveBeenCalledWith("proj_1", "crawl", [{ a: 1 }, { b: 2 }], 30);
  });

  test("POST /queues/:queueName/messages/receive leases the next available message", async () => {
    pgmqRead.mockResolvedValueOnce([queueMessageFixture({
      id: "11", msg_id: "11", payload: { hello: "world" }, message: { hello: "world" },
    })]);

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
    expect(pgmqArchive).toHaveBeenCalledWith("proj_1", "emails", "11");
  });

  test("POST /queues/:queueName/messages/pop deletes and returns next PGMQ message", async () => {
    pgmqPop.mockResolvedValueOnce(queueMessageFixture({
      id: "12", msg_id: "12", status: "deleted", payload: { ok: true }, message: { ok: true },
    }));

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
    expect(pgmqDeleteMessage).toHaveBeenCalledWith("proj_1", "emails", "11");
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
      taskFixture({ function_slug: "mockup-generator", status: "running" }),
    ]);

    const response = await request(
      "/v1/projects/proj_1/tasks?function_slug=mockup-generator&limit=8",
    );

    expect(response.status).toBe(200);
    expect(listTasksByProjectFiltered).toHaveBeenCalledWith("proj_1", {
      functionSlug: "mockup-generator",
      onlyDeadLettered: false,
      limit: 8,
      summary: false,
    });
  });

  test("GET /v1/projects/:ref/tasks forwards summary list mode to repository", async () => {
    listTasksByProjectFiltered.mockResolvedValueOnce([
      taskFixture({ function_slug: "mockup-generator", status: "running" }),
    ]);

    const response = await request(
      "/v1/projects/proj_1/tasks?function_slug=mockup-generator&limit=8&summary=true",
    );

    expect(response.status).toBe(200);
    expect(listTasksByProjectFiltered).toHaveBeenCalledWith("proj_1", {
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
    getTaskById.mockResolvedValueOnce(taskFixture({
      id: "tsk_running",
      status: TaskStatus.RUNNING,
      project_ref: "proj_1",
    })).mockResolvedValueOnce(taskFixture({
      id: "tsk_running",
      status: TaskStatus.RUNNING,
      cancel_requested_at: new Date("2026-04-17T12:00:00.000Z"),
    }));

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
    getTaskById.mockResolvedValueOnce(taskFixture({
      id: "tsk_done",
      status: TaskStatus.PENDING,
      project_ref: "proj_1",
    })).mockResolvedValueOnce(taskFixture({
      id: "tsk_done",
      status: TaskStatus.CANCELLED,
    }));
    backgroundFunctionWorker.cancel.mockResolvedValueOnce(true);

    const response = await request("/v1/projects/proj_1/tasks/tsk_done/cancel", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(backgroundFunctionWorker.cancel).toHaveBeenCalledWith("tsk_done");
  });

  test("POST /:taskId/cancel returns 409 for terminal tasks", async () => {
    getTaskById.mockResolvedValueOnce(taskFixture({
      id: "tsk_done",
      status: TaskStatus.SUCCEEDED,
      project_ref: "proj_1",
    }));

    const response = await request("/v1/projects/proj_1/tasks/tsk_done/cancel", {
      method: "POST",
    });

    expect(response.status).toBe(409);
    expect(backgroundFunctionWorker.cancel).not.toHaveBeenCalled();
    expect(cancelTask).not.toHaveBeenCalled();
  });

  test("POST /:taskId/retry binds the authenticated project to the repository mutation", async () => {
    retryTask.mockResolvedValueOnce(taskFixture({ id: "tsk_failed", project_ref: "proj_1", status: "pending" }));
    const response = await request("/v1/projects/proj_1/tasks/tsk_failed/retry", { method: "POST" });
    expect(response.status).toBe(200);
    expect(retryTask).toHaveBeenCalledTimes(1);
    expect(retryTask).toHaveBeenCalledWith("tsk_failed", "proj_1");
  });

  test("POST /:taskId/retry cannot retry or disclose a failed database write", async () => {
    retryTask.mockRejectedValueOnce(new Error("private-database-detail"));
    const response = await request("/v1/projects/proj_1/tasks/tsk_failed/retry", { method: "POST" });
    expect(response.status).toBe(500);
    const body: unknown = await response.json();
    expect(body).toEqual({ message: "Failed to retry task", code: "500" });
    expect(retryTask).toHaveBeenCalledTimes(1);
  });

  test("GET /:taskId returns attempts and latest_logs", async () => {
    getTaskById.mockResolvedValueOnce(taskFixture({
      id: "tsk_1",
      status: "dead_lettered",
      project_ref: "proj_1",
      function_slug: "mockup-generator",
    }));
    listTaskAttempts.mockResolvedValueOnce([
      taskAttemptFixture({
        attempt_no: 2,
        logs: [{ timestamp: "2026-04-17T12:00:00.000Z", stream: "stderr", level: "error", message: "boom" }],
      }),
      taskAttemptFixture({
        attempt_no: 1,
        logs: [],
      }),
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
    getTaskById.mockResolvedValueOnce(taskFixture({
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
    }));
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
    getTaskById.mockResolvedValueOnce(taskFixture({
      id: "tsk_user",
      status: "succeeded",
      project_ref: "proj_1",
      payload: {
        auth: {
          invoker_user_id: "user_1",
        },
      },
    }));

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
