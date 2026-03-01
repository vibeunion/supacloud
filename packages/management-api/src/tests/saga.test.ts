import { expect, test, describe, spyOn, beforeEach } from "bun:test";
import { taskWorker } from "../services/task.worker";
import { taskRepository } from "../repositories/task.repository";
import { projectRepository } from "../repositories/project.repository";

describe("Saga 任务流转 Mock 测试", () => {

    test("任务完成后应自动触发下一个 Saga 阶段", async () => {
        // Mock 数据库操作
        const claimSpy = spyOn(taskRepository, "claimNextTask").mockResolvedValueOnce({
            id: "task-1",
            project_ref: "p-1",
            task_type: "provision_db",
            status: "processing",
            payload: { dbPassword: "pw" }
        } as any);

        const updateStatusSpy = spyOn(taskRepository, "updateStatus").mockResolvedValue({} as any);
        const createTaskSpy = spyOn(taskRepository, "createTask").mockResolvedValue({} as any);
        const findProjectSpy = spyOn(projectRepository, "findByRef").mockResolvedValue({ db_password: "pw" } as any);

        // 执行一次 Poll
        // @ts-expect-error: 访问私有方法进行测试
        const executeSpy = spyOn(taskWorker, "executeTask").mockResolvedValue(true);
        // @ts-expect-error: 访问私有方法进行测试
        await taskWorker.poll();

        // 验证: provision_db 完成后应创建 provision_s3
        expect(updateStatusSpy).toHaveBeenCalledWith("task-1", "completed");
        expect(createTaskSpy).toHaveBeenCalledWith("p-1", "provision_s3");

        claimSpy.mockRestore();
        updateStatusSpy.mockRestore();
        createTaskSpy.mockRestore();
        findProjectSpy.mockRestore();
    });

    test("任务失败时应触发 Saga 补偿逻辑", async () => {
        // 模拟 S3 创建失败的情况
        const claimSpy = spyOn(taskRepository, "claimNextTask").mockResolvedValueOnce({
            id: "task-2",
            project_ref: "p-2",
            task_type: "provision_s3",
            status: "processing"
        } as any);

        // 模拟执行失败
        // @ts-expect-error: 访问私有方法进行测试
        const executeSpyComp = spyOn(taskWorker, "executeTask").mockResolvedValue(false);
        const updateStatusSpy = spyOn(taskRepository, "updateStatus").mockResolvedValue({} as any);
        const createTaskSpy = spyOn(taskRepository, "createTask").mockResolvedValue({} as any);
        const updateProjectStatusSpy = spyOn(projectRepository, "updateStatus").mockResolvedValue({} as any);

        // @ts-expect-error: 访问私有方法进行测试
        await taskWorker.poll();

        // 验证: S3 失败应回滚 DB (加入 cleanup_db 任务)
        expect(updateStatusSpy).toHaveBeenCalledWith("task-2", "failed", "Task execution failed");
        expect(createTaskSpy).toHaveBeenCalledWith("p-2", "cleanup_db");
        expect(updateProjectStatusSpy).toHaveBeenCalledWith("p-2", "paused");

        claimSpy.mockRestore();
        executeSpyComp.mockRestore();
        updateStatusSpy.mockRestore();
        createTaskSpy.mockRestore();
        updateProjectStatusSpy.mockRestore();
    });
});
