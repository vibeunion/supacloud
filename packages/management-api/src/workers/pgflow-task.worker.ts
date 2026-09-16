import { sql } from "../db";
import { reconcilePgflowTask } from "../services/pgflow-task.service";
import { logger } from "../utils/logger";

let timer: ReturnType<typeof setInterval> | undefined;
let active: Promise<void> | undefined;

export function reconcilePgflowTasks(): Promise<void> {
    if (active) return active;
    active = (async () => {
        const rows: { id: string; project_ref: string }[] = await sql`
            SELECT id, project_ref FROM project_tasks
            WHERE task_type = 'pgflow' AND status IN ('pending', 'running')
            ORDER BY updated_at, id LIMIT 100
        `;
        for (const task of rows) {
            try {
                await reconcilePgflowTask(task.id, task.project_ref);
            } catch {
                // Rotate unavailable tenants so one outage does not starve later tasks.
                await sql`
                    UPDATE project_tasks SET updated_at = NOW()
                    WHERE id = ${task.id}::uuid AND status IN ('pending', 'running')
                `;
                logger.warn("[pgflow] Reconciliation deferred", { taskId: task.id });
            }
        }
    })().finally(() => { active = undefined; });
    return active;
}

export function startPgflowTaskWorker(): void {
    if (timer) return;
    const poll = () => {
        void reconcilePgflowTasks().catch(() => logger.warn("[pgflow] Task scan failed"));
    };
    timer = setInterval(poll, 5000);
    poll();
}

export async function stopPgflowTaskWorker(): Promise<void> {
    if (timer) clearInterval(timer);
    timer = undefined;
    await active;
}
