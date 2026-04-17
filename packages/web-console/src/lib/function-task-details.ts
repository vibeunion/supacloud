import type { FunctionTaskRecord } from "./function-snippets";

export type FunctionTaskLogEntry = {
  timestamp: string;
  stream: "stdout" | "stderr";
  level: string;
  message: string;
};

export function getTaskLatestLogPreview(
  task: FunctionTaskRecord,
  maxEntries = 3,
): FunctionTaskLogEntry[] {
  return (task.latest_logs || []).slice(0, maxEntries);
}

export function hasTaskLogPreview(task: FunctionTaskRecord): boolean {
  return Array.isArray(task.latest_logs) && task.latest_logs.length > 0;
}
