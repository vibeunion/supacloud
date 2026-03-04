import { sql, type ProjectTask, type TaskStatus, type TaskType } from "../db";
import { withRetry } from "../utils/retry";

export class TaskRepository {
  /**
   * Create task
   */
  async createTask(ref: string, type: TaskType, payload: Record<string, any> = {}): Promise<ProjectTask> {
    return withRetry("TaskRepository.createTask", async () => {
      const [task] = await sql`
                INSERT INTO project_tasks (project_ref, task_type, payload)
                VALUES (${ref}, ${type}, ${JSON.stringify(payload)})
                RETURNING *
            `;
      return task as ProjectTask;
    });
  }

  /**
   * Batch create tasks, ensuring serial dependency for sequential execution,
   * can be implemented via timestamps or external scheduler,
   * simple implementation here just enqueues all.
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
   * Get next pending task and lock it (SKIP LOCKED)
   * Supports retrying tasks with failure count < 3
   */
  async claimNextTask(): Promise<ProjectTask | null> {
    return withRetry("TaskRepository.claimNextTask", async () => {
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
    });
  }

  /**
   * Update task status
   */
  async updateStatus(id: string, status: TaskStatus, error?: string): Promise<ProjectTask | null> {
    return withRetry("TaskRepository.updateStatus", async () => {
      const [task] = await sql`
                UPDATE project_tasks
                SET status = ${status}, error = ${error || null}, updated_at = NOW()
                WHERE id = ${id}
                RETURNING *
            `;
      return (task as ProjectTask) || null;
    });
  }

  /**
   * Update task error info
   */
  async updateTaskError(id: string, error: string): Promise<void> {
    return withRetry("TaskRepository.updateTaskError", async () => {
      await sql`
                UPDATE project_tasks
                SET error = ${error}, updated_at = NOW()
                WHERE id = ${id}
            `;
    });
  }
}

export const taskRepository = new TaskRepository();
