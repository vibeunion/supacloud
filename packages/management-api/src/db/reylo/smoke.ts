import type { SQL } from "bun";
import { queries } from "./queries";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export type ControlPlaneSmokeReport = {
  project_ref: string;
  queries: number;
  rows: {
    project: number;
    tasks: number;
    due_tasks: number;
    status_counts: number;
    task: number;
    task_attempts: number;
    organization: number;
  };
};

export async function runReadOnlySmoke(db: SQL, projectRef: string): Promise<ControlPlaneSmokeReport> {
  const project = await queries.getProject(db, projectRef);
  const tasks = await queries.listProjectTasks(db, projectRef);
  const dueTasks = await queries.listDueTasks(db, projectRef);
  const statusCounts = await queries.countTasksByStatus(db, projectRef);
  const task = await queries.getTask(db, tasks[0]?.id ?? ZERO_UUID);
  const attempts = await queries.listTaskAttempts(db, task?.id ?? ZERO_UUID);
  const organization = await queries.getOrganization(db, project?.organization_id ?? ZERO_UUID);

  return {
    project_ref: projectRef,
    queries: 7,
    rows: {
      project: project === null ? 0 : 1,
      tasks: tasks.length,
      due_tasks: dueTasks.length,
      status_counts: statusCounts.length,
      task: task === null ? 0 : 1,
      task_attempts: attempts.length,
      organization: organization === null ? 0 : 1,
    },
  };
}
