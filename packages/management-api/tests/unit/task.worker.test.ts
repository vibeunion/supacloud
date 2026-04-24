import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { taskRepository } from "../../src/repositories/task.repository";
import { projectRepository } from "../../src/repositories/project.repository";
import { TaskWorker } from "../../src/services/task.worker";

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
