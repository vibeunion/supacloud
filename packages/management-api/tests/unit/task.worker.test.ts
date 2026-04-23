import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { taskRepository } from "../../src/repositories/task.repository";
import { projectRepository } from "../../src/repositories/project.repository";
import { TaskWorker } from "../../src/services/task.worker";

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
