// @supacloud-test-isolate
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { TaskStatus } from "../../src/db";
import { taskRepository } from "../../src/repositories/task.repository";
import { projectRepository } from "../../src/repositories/project.repository";
import * as dispatcher from "../../src/services/background-runtime-dispatcher";
import * as mirror from "../../src/services/background-task.service";
import * as listen from "../../src/lib/pg-listen";
import * as ws from "../../src/routes/ws";
import { logger } from "../../src/utils/logger";
import { taskAttemptFixture, taskFixture, taskProjectFixture } from "../helpers/task-fixtures";
import { BackgroundFunctionWorker } from "../../src/services/background-function-worker";

const claim = spyOn(taskRepository, "claimNextTask");
const project = spyOn(projectRepository, "findByRef");
const extend = spyOn(taskRepository, "extendLease");
const transition = spyOn(taskRepository, "transitionTaskToRunning");
const complete = spyOn(taskRepository, "completeTaskAttempt");
const succeeded = spyOn(taskRepository, "markTaskSucceeded");
const failed = spyOn(taskRepository, "markTaskFailed");
const retry = spyOn(taskRepository, "scheduleRetry");
const dispatch = spyOn(dispatcher, "dispatchBackgroundFunction");
const createMirror = spyOn(mirror, "createBackgroundTaskMirrorIfUserExists");
const removeMirror = spyOn(mirror, "removeBackgroundTaskMirror");
const listener = spyOn(listen, "createPgListener");
const broadcast = spyOn(ws, "broadcastTaskUpdate");
const errorLog = spyOn(logger, "error");
const getTask = spyOn(taskRepository, "getTaskById");
const cancelRequest = spyOn(taskRepository, "requestTaskCancellation");
const cancelled = spyOn(taskRepository, "cancelTask");
const spies = [claim, project, extend, transition, complete, succeeded, failed, retry, dispatch,
  createMirror, removeMirror, listener, broadcast, errorLog, getTask, cancelRequest, cancelled];

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Worker did not settle");
    await Bun.sleep(1);
  }
}

describe("background outcome preservation", () => {
  beforeEach(() => {
    for (const spy of spies) spy.mockReset();
    claim.mockResolvedValueOnce(taskFixture()).mockResolvedValue(null);
    project.mockResolvedValue(taskProjectFixture());
    extend.mockImplementation(async () => taskFixture());
    transition.mockImplementation(async (_id, task) => ({ task: { ...task, status: TaskStatus.RUNNING }, attempt: taskAttemptFixture() }));
    complete.mockImplementation(async (taskId, attemptNo, input) => taskAttemptFixture({
      task_id: taskId, attempt_no: attemptNo, status: input.status,
    }));
    succeeded.mockResolvedValue(taskFixture({ status: TaskStatus.SUCCEEDED }));
    failed.mockResolvedValue(taskFixture({ status: TaskStatus.DEAD_LETTERED }));
    retry.mockResolvedValue(taskFixture({ status: TaskStatus.RETRY_SCHEDULED }));
    dispatch.mockResolvedValue({ status: 200, headers: {}, bodyText: "written", logs: [] });
    createMirror.mockResolvedValue({ inserted: false, userExists: true });
    removeMirror.mockResolvedValue(true);
    listener.mockReturnValue({ close() {} });
    broadcast.mockImplementation(() => {});
    errorLog.mockImplementation(() => {});
    getTask.mockResolvedValue(taskFixture({ status: TaskStatus.RUNNING }));
    cancelRequest.mockResolvedValue(taskFixture({ status: TaskStatus.RUNNING, cancel_requested_at: new Date() }));
    cancelled.mockResolvedValue(taskFixture({ status: TaskStatus.CANCELLED }));
  });
  afterAll(() => { for (const spy of spies) spy.mockRestore(); });

  test("unknown execution receipts dead-letter without scheduling a replay", async () => {
    dispatch.mockRejectedValue(new dispatcher.BackgroundDispatchOutcomeUnknownError());
    const worker = new BackgroundFunctionWorker();
    try {
      worker.start(60_000);
      await until(() => removeMirror.mock.calls.length === 1);
      expect(failed).toHaveBeenCalledWith("tsk_1", expect.stringContaining("outcome is unknown"), true);
      expect(complete).toHaveBeenCalledWith("tsk_1", 1, expect.objectContaining({ status: "dead_lettered", responseStatus: 502 }));
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(retry).not.toHaveBeenCalled();
      expect(succeeded).not.toHaveBeenCalled();
    } finally { worker.stop(); }
  });

  test("a failed outcome write cannot turn a successful execution into a scheduled retry", async () => {
    for (const failure of ["attempt", "task", "missing attempt", "missing task"]) {
      complete.mockClear();
      succeeded.mockClear();
      errorLog.mockClear();
      removeMirror.mockClear();
      claim.mockReset().mockResolvedValueOnce(taskFixture()).mockResolvedValue(null);
      complete.mockResolvedValue(taskAttemptFixture({ status: "succeeded" }));
      succeeded.mockResolvedValue(taskFixture({ status: TaskStatus.SUCCEEDED }));
      if (failure === "attempt") complete.mockRejectedValue(new Error("Attempt persistence unavailable"));
      else if (failure === "task") succeeded.mockRejectedValue(new Error("Task persistence unavailable"));
      else if (failure === "missing attempt") complete.mockResolvedValue(null);
      else succeeded.mockResolvedValue(null);
      const worker = new BackgroundFunctionWorker();
      try {
        worker.start(60_000);
        await until(() => errorLog.mock.calls.some(([message]) =>
          typeof message === "string" && message.includes("unhandled task execution failure")));
        expect(retry).not.toHaveBeenCalled();
        expect(failed).not.toHaveBeenCalled();
        expect(removeMirror).toHaveBeenCalledTimes(1);
        expect(broadcast.mock.calls.some(([event]) => event.status === TaskStatus.SUCCEEDED)).toBe(false);
      } finally { worker.stop(); }
    }
  });

  test("receipts for another identity, attempt or status cannot announce execution success", async () => {
    for (const receipt of [
      taskAttemptFixture({ task_id: "other", status: "succeeded" }),
      taskAttemptFixture({ project_ref: "other", status: "succeeded" }),
      taskAttemptFixture({ attempt_no: 2, status: "succeeded" }),
      taskAttemptFixture({ status: "running" }),
    ]) {
      claim.mockReset().mockResolvedValueOnce(taskFixture()).mockResolvedValue(null);
      complete.mockResolvedValue(receipt);
      errorLog.mockClear();
      const worker = new BackgroundFunctionWorker();
      try {
        worker.start(60_000);
        await until(() => errorLog.mock.calls.some(([message]) =>
          typeof message === "string" && message.includes("unhandled task execution failure")));
        expect(succeeded).not.toHaveBeenCalled();
        expect(retry).not.toHaveBeenCalled();
        expect(broadcast.mock.calls.some(([event]) => event.status === TaskStatus.SUCCEEDED)).toBe(false);
      } finally { worker.stop(); }
    }
  });

  test("a cancellation receipt for a different task cannot announce cancellation or replay execution", async () => {
    dispatch.mockResolvedValue({ status: 499, headers: {}, bodyText: "", logs: [] });
    cancelled.mockResolvedValue(taskFixture({ id: "other", status: TaskStatus.CANCELLED }));
    const worker = new BackgroundFunctionWorker();
    try {
      worker.start(60_000);
      await until(() => errorLog.mock.calls.some(([message]) =>
        typeof message === "string" && message.includes("unhandled task execution failure")));
      expect(retry).not.toHaveBeenCalled();
      expect(broadcast.mock.calls.some(([event]) => event.status === TaskStatus.CANCELLED)).toBe(false);
    } finally { worker.stop(); }
  });

  test("explicit function failures retain the configured retry policy", async () => {
    dispatch.mockResolvedValue({ status: 503, headers: {}, bodyText: "", logs: [] });
    const worker = new BackgroundFunctionWorker();
    try {
      worker.start(60_000);
      await until(() => removeMirror.mock.calls.length === 1);
      expect(retry).toHaveBeenCalledWith("tsk_1", "Background function returned HTTP 503", expect.any(Date));
      expect(complete).toHaveBeenCalledWith("tsk_1", 1, expect.objectContaining({ responseStatus: 503, status: "retry_scheduled" }));
    } finally { worker.stop(); }
  });

  test("only a boolean cancellation confirmation can report success", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      for (const cancelled of ["false", "true", 1, {}, [], null, false, true]) {
        fetchSpy.mockResolvedValue(Response.json({ cancelled }));
        const worker = new BackgroundFunctionWorker();
        expect(await worker.cancel("tsk_1")).toBe(cancelled === true);
      }
    } finally { fetchSpy.mockRestore(); }
  });
});
