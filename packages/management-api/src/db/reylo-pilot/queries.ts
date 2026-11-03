import type { SQL } from "bun";
import organizationGet from "./queries/organization_get.sql";
import projectGet from "./queries/project_get.sql";
import taskAttemptsList from "./queries/task_attempts_list.sql";
import taskGet from "./queries/task_get.sql";
import taskListDue from "./queries/task_list_due.sql";
import taskListForProject from "./queries/task_list_for_project.sql";
import taskStatusCounts from "./queries/task_status_counts.sql";

export type ProjectTaskSummary = {
  id: string;
  project_ref: string | null;
  task_type: string;
  status: string | null;
  attempt: number | null;
  max_attempts: number | null;
  next_run_at: Date | null;
  lease_until: Date | null;
  created_at: Date | null;
  updated_at: Date | null;
  started_at?: Date | null;
  completed_at?: Date | null;
};

export type ProjectRef = {
  id: string;
  ref: string;
  organization_id: string | null;
  name: string;
  status: string | null;
  region: string | null;
  created_at: Date | null;
  updated_at: Date | null;
  deleted_at: Date | null;
};

export type OrganizationRef = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  created_at: Date | null;
  updated_at: Date | null;
};

export type TaskStatusCount = { status: string | null; count: number };

export type TaskAttemptSummary = {
  id: string;
  task_id: string;
  project_ref: string;
  attempt_no: number;
  status: string;
  started_at: Date;
  completed_at: Date | null;
  duration_ms: number | null;
  error: string | null;
  response_status: number | null;
};

export type ReyloPilotQueries = {
  getTask(db: SQL, id: string): Promise<ProjectTaskSummary | null>;
  listProjectTasks(db: SQL, projectRef: string, limit?: number): Promise<ProjectTaskSummary[]>;
  listDueTasks(db: SQL, projectRef: string, limit?: number): Promise<ProjectTaskSummary[]>;
  countTasksByStatus(db: SQL, projectRef: string): Promise<TaskStatusCount[]>;
  listTaskAttempts(db: SQL, taskId: string, limit?: number): Promise<TaskAttemptSummary[]>;
  getProject(db: SQL, ref: string): Promise<ProjectRef | null>;
  getOrganization(db: SQL, id: string): Promise<OrganizationRef | null>;
};

function timestamp(value: string | Date | null): Date | null {
  if (value === null) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid database timestamp: ${value}`);
  return parsed;
}

function requiredTimestamp(value: string | Date): Date {
  const parsed = timestamp(value);
  if (parsed === null) throw new Error("Expected a required database timestamp");
  return parsed;
}

function taskSummary(row: {
  id: string;
  project_ref: string | null;
  task_type: string;
  status: string | null;
  attempt: number | null;
  max_attempts: number | null;
  next_run_at: string | Date | null;
  lease_until: string | Date | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
  started_at?: string | Date | null;
  completed_at?: string | Date | null;
}): ProjectTaskSummary {
  const result: ProjectTaskSummary = {
    id: row.id,
    project_ref: row.project_ref,
    task_type: row.task_type,
    status: row.status,
    attempt: row.attempt,
    max_attempts: row.max_attempts,
    next_run_at: timestamp(row.next_run_at),
    lease_until: timestamp(row.lease_until),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
  };
  if (row.started_at !== undefined) result.started_at = timestamp(row.started_at);
  if (row.completed_at !== undefined) result.completed_at = timestamp(row.completed_at);
  return result;
}

export const queries: ReyloPilotQueries = {
  async getTask(db, id) {
    const row = await taskGet.run(db, { id });
    return row === null ? null : taskSummary(row);
  },

  async listProjectTasks(db, projectRef, limit = 20) {
    const rows = await taskListForProject.run(db, { project_ref: projectRef, limit });
    return rows.map(taskSummary);
  },

  async listDueTasks(db, projectRef, limit = 20) {
    const rows = await taskListDue.run(db, { project_ref: projectRef, limit });
    return rows.map(taskSummary);
  },

  async countTasksByStatus(db, projectRef) {
    return taskStatusCounts.run(db, { project_ref: projectRef });
  },

  async listTaskAttempts(db, taskId, limit = 20) {
    const rows = await taskAttemptsList.run(db, { task_id: taskId, limit });
    return rows.map((row) => ({
      ...row,
      started_at: requiredTimestamp(row.started_at),
      completed_at: timestamp(row.completed_at),
    }));
  },

  async getProject(db, ref) {
    const row = await projectGet.run(db, { ref });
    return row === null ? null : {
      ...row,
      created_at: timestamp(row.created_at),
      updated_at: timestamp(row.updated_at),
      deleted_at: timestamp(row.deleted_at),
    };
  },

  async getOrganization(db, id) {
    const row = await organizationGet.run(db, { id });
    return row === null ? null : {
      ...row,
      created_at: timestamp(row.created_at),
      updated_at: timestamp(row.updated_at),
    };
  },
};
