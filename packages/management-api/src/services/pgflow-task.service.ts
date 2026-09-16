import { getProjectDb } from "../db";
import { projectRepository } from "../repositories/project.repository";
import { readPgmqProjectDatabase } from "../utils/pgmq-project";

const idPattern =
  /^pgflow:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export const isPgflowTask = (id: string): boolean => id.startsWith("pgflow:");

export class PgflowTaskReadError extends Error {
  constructor() {
    super("PGFLOW_TASKS_UNAVAILABLE");
    this.name = "PgflowTaskReadError";
  }
}

export interface PgflowTaskFilters {
  limit: number;
  statuses?: string[];
}

export interface PgflowTask {
  id: string;
  project_ref: string;
  task_type: "pgflow";
  status: "pending" | "running" | "retry_scheduled" | "succeeded" | "failed";
  executor: {
    kind: "pgflow";
    version: string;
    definition: string;
    run_id: string;
    native_status: string;
  };
  capabilities: { cancel: false; retry: false };
  blocked_reason: string | null;
  total_steps: number;
  finished_steps: number;
  created_at: Date;
  started_at: Date;
  completed_at: Date | null;
  updated_at: Date;
  error: string | null;
  result: unknown;
}

async function database(projectRef: string) {
  const project: unknown = await projectRepository.findByRef(projectRef);
  return getProjectDb(readPgmqProjectDatabase(project, projectRef));
}

export const pgflowTaskService = {
  async list(
    projectRef: string,
    filters: PgflowTaskFilters,
  ): Promise<PgflowTask[]> {
    try {
      const db = await database(projectRef);
      const [installed] = await db<
        { ready: boolean }[]
      >`SELECT to_regclass('supacloud_worker.tasks') IS NOT NULL AS ready`;
      if (!installed?.ready) return [];
      return await db<PgflowTask[]>`
      SELECT * FROM supacloud_worker.tasks
      WHERE project_ref=${projectRef}
        AND (${filters.statuses === undefined} OR status=ANY(${db.array(filters.statuses ?? [], "TEXT")}))
      ORDER BY created_at DESC, id DESC LIMIT ${Math.min(filters.limit, 200)}
    `;
    } catch {
      throw new PgflowTaskReadError();
    }
  },
  async get(projectRef: string, id: string): Promise<PgflowTask | null> {
    if (!idPattern.test(id)) return null;
    try {
      const db = await database(projectRef);
      const [installed] = await db<
        { ready: boolean }[]
      >`SELECT to_regclass('supacloud_worker.tasks') IS NOT NULL AS ready`;
      if (!installed?.ready) return null;
      const [task] = await db<PgflowTask[]>`
      SELECT * FROM supacloud_worker.tasks WHERE project_ref=${projectRef} AND id=${id}
    `;
      return task ?? null;
    } catch {
      throw new PgflowTaskReadError();
    }
  },
};
