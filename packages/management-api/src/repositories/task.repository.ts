import { sql, type ProjectTask, type TaskStatus, type TaskType } from "../db";

export class TaskRepository {
    /**
     * 创建任务
     */
    async createTask(ref: string, type: TaskType, payload: Record<string, any> = {}): Promise<ProjectTask> {
        const [task] = await sql`
      INSERT INTO project_tasks (project_ref, task_type, payload)
      VALUES (${ref}, ${type}, ${JSON.stringify(payload)})
      RETURNING *
    `;
        return task as ProjectTask;
    }

    /**
     * 批量创建任务，保证顺序执行的串行依赖，可以通过按时间戳或外部调度器实现，
     * 这里的简单实现就是都入队。
     */
    async createTasks(tasks: { ref: string; type: TaskType; payload?: Record<string, any> }[]): Promise<void> {
        if (tasks.length === 0) return;

        // We add them one by one to avoid complex Postgres unnesting for JSON in bun-js sql tagged logs,
        // or we can just iterate.
        for (const t of tasks) {
            await this.createTask(t.ref, t.type, t.payload || {});
        }
    }

    /**
     * 获取下一个要处理的 pending 任务并锁定 (SKIP LOCKED)
     * 支持重试失败次数 < 3 的任务
     */
    async claimNextTask(): Promise<ProjectTask | null> {
        const [task] = await sql`
      UPDATE project_tasks
      SET status = 'processing', updated_at = NOW(), retries = retries + 1
      WHERE id = (
        SELECT id FROM project_tasks
        WHERE (status = 'pending' OR (status = 'failed' AND retries < 3))
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *
    `;
        return (task as ProjectTask) || null;
    }

    /**
     * 更新任务状态
     */
    async updateStatus(id: string, status: TaskStatus, error?: string): Promise<ProjectTask | null> {
        const [task] = await sql`
      UPDATE project_tasks
      SET status = ${status}, error = ${error || null}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
        return (task as ProjectTask) || null;
    }

    /**
     * 更新任务错误信息
     */
    async updateTaskError(id: string, error: string): Promise<void> {
        await sql`
      UPDATE project_tasks
      SET error = ${error}, updated_at = NOW()
      WHERE id = ${id}
    `;
    }
}

export const taskRepository = new TaskRepository();
