import type { FunctionTaskRecord } from "./function-snippets";

export type FunctionTaskSummary = {
  running: number;
  retryScheduled: number;
  deadLettered: number;
  failed: number;
  cancelled: number;
  recentFailures: FunctionTaskRecord[];
};

export function summarizeFunctionTasks(
  tasks: FunctionTaskRecord[],
): FunctionTaskSummary {
  return {
    running: tasks.filter((task) => task.status === "running" || task.status === "leased").length,
    retryScheduled: tasks.filter((task) => task.status === "retry_scheduled").length,
    deadLettered: tasks.filter((task) => task.status === "dead_lettered").length,
    failed: tasks.filter((task) => task.status === "failed").length,
    cancelled: tasks.filter((task) => task.status === "cancelled").length,
    recentFailures: tasks.filter((task) =>
      task.status === "failed" || task.status === "dead_lettered"
    ),
  };
}
