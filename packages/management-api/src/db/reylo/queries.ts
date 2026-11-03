import type { SQL } from "bun";
import { decodeProjectTask, type ProjectTask } from "../contracts/task-row";
import { parseTaskAttemptRecord } from "../../utils/task-record";
import { readTaskStatistics, type TaskStatistics } from "../../utils/task-statistics";
import type { ProjectTaskAttempt } from "../index";
import organizationGet from "./queries/organization_get.sql";
import projectGet from "./queries/project_get.sql";
import taskAttemptsFull from "./queries/task_attempts_full.sql";
import taskAttemptsList from "./queries/task_attempts_list.sql";
import taskGet from "./queries/task_get.sql";
import taskGetFull from "./queries/task_get_full.sql";
import taskGetFullUnscoped from "./queries/task_get_full_unscoped.sql";
import taskListDue from "./queries/task_list_due.sql";
import taskListForProject from "./queries/task_list_for_project.sql";
import taskStatsSummary from "./queries/task_stats_summary.sql";
import taskStatsTopFailures from "./queries/task_stats_top_failures.sql";
import taskStatsTrend from "./queries/task_stats_trend.sql";
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

export type ControlPlaneQueries = {
  getTask(db: SQL, id: string, projectRef?: string): Promise<ProjectTask | null>;
  getTaskSummary(db: SQL, id: string): Promise<ProjectTaskSummary | null>;
  listProjectTasks(db: SQL, projectRef: string, limit?: number): Promise<ProjectTaskSummary[]>;
  listDueTasks(db: SQL, projectRef: string, limit?: number): Promise<ProjectTaskSummary[]>;
  countTasksByStatus(db: SQL, projectRef: string): Promise<TaskStatusCount[]>;
  listTaskAttempts(db: SQL, taskId: string): Promise<ProjectTaskAttempt[]>;
  listTaskAttemptSummaries(db: SQL, taskId: string, limit?: number): Promise<TaskAttemptSummary[]>;
  getTaskStats(db: SQL, projectRef: string): Promise<TaskStatistics>;
  getProject(db: SQL, ref: string): Promise<ProjectRef | null>;
  getOrganization(db: SQL, id: string): Promise<OrganizationRef | null>;
};

const TASK_TIMESTAMP_COLUMNS = [
  "next_run_at", "lease_until", "started_at", "completed_at",
  "cancel_requested_at", "created_at", "updated_at",
] as const;
const ATTEMPT_TIMESTAMP_COLUMNS = [
  "started_at", "completed_at", "created_at", "updated_at",
] as const;

function timestamp(value: unknown): Date | null {
  if (value === null) return null;
  if (value instanceof Date) return value;
  if (typeof value !== "string") throw new Error(`Invalid database timestamp: ${String(value)}`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid database timestamp: ${value}`);
  return parsed;
}

function normalizeTimestamps(
  row: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const normalized = { ...row };
  for (const field of fields) {
    if (field in normalized) normalized[field] = timestamp(normalized[field]);
  }
  return normalized;
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

export const queries: ControlPlaneQueries = {
  async getTask(db, id, projectRef) {
    const row = projectRef
      ? await taskGetFull.run(db, { id, project_ref: projectRef })
      : await taskGetFullUnscoped.run(db, { id });
    if (row === null) return null;
    return decodeProjectTask(normalizeTimestamps(row, TASK_TIMESTAMP_COLUMNS));
  },

  async getTaskSummary(db, id) {
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

  async listTaskAttempts(db, taskId) {
    const rows = await taskAttemptsFull.run(db, { task_id: taskId });
    return rows.map((row: Record<string, unknown>) => parseTaskAttemptRecord(normalizeTimestamps(row, ATTEMPT_TIMESTAMP_COLUMNS)));
  },

  async listTaskAttemptSummaries(db, taskId, limit = 20) {
    const rows = await taskAttemptsList.run(db, { task_id: taskId, limit });
    return rows.map((row: Record<string, unknown>) => ({
      ...row,
      started_at: timestamp(row.started_at) as Date,
      completed_at: timestamp(row.completed_at),
    }) as TaskAttemptSummary);
  },

  async getTaskStats(db, projectRef) {
    const [summaryRows, trendRows, topFailureRows] = await Promise.all([
      taskStatsSummary.run(db, { project_ref: projectRef }),
      taskStatsTrend.run(db, { project_ref: projectRef }),
      taskStatsTopFailures.run(db, { project_ref: projectRef }),
    ]);
    const summary = summaryRows;
    return readTaskStatistics({
      running: summary?.running ?? 0,
      retryScheduled: summary?.retry_scheduled ?? 0,
      deadLettered: summary?.dead_lettered ?? 0,
      failedLast24h: summary?.failed_last_24h ?? 0,
      cancelledLast24h: summary?.cancelled_last_24h ?? 0,
      topFailures: topFailureRows,
      failedTrend: trendRows,
    });
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
