import type { SupabaseClient } from "@supabase/supabase-js";

export type InvokeAsyncOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  retries?: number;
  timeoutSec?: number;
  idempotencyKey?: string;
  method?: string;
};

export type TaskLogEntry = {
  timestamp: string;
  stream: "stdout" | "stderr";
  level: string;
  message: string;
};

export type TaskAttempt = {
  attempt_no: number;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  response_status: number | null;
  error: string | null;
  logs: TaskLogEntry[];
};

export type TaskDetail = {
  id: string;
  status:
    | "pending"
    | "leased"
    | "running"
    | "retry_scheduled"
    | "succeeded"
    | "failed"
    | "dead_lettered"
    | "cancelled";
  function_slug: string | null;
  attempt: number | null;
  max_attempts: number | null;
  error: string | null;
  result: unknown;
  attempts: TaskAttempt[];
};

const terminalStatuses = new Set<TaskDetail["status"]>([
  "succeeded",
  "failed",
  "dead_lettered",
  "cancelled",
]);

export async function invokeAsync(
  supabase: SupabaseClient,
  functionName: string,
  options: InvokeAsyncOptions = {},
) {
  const {
    body,
    headers = {},
    method,
  } = options;

  const { data, error } = await supabase.functions.invoke(functionName, {
    body,
    method,
    headers,
  });

  if (error) throw error;

  return data as {
    task_id: string;
    status: "enqueued";
  };
}

export async function getTask(
  managementApiUrl: string,
  projectRef: string,
  taskId: string,
  accessToken: string,
) {
  const response = await fetch(
    `${managementApiUrl}/v1/projects/${projectRef}/tasks/${taskId}`,
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch task: ${response.status}`);
  }

  return (await response.json()) as TaskDetail;
}

export async function waitForTask(
  managementApiUrl: string,
  projectRef: string,
  taskId: string,
  accessToken: string,
  intervalMs = 2000,
) {
  while (true) {
    const task = await getTask(managementApiUrl, projectRef, taskId, accessToken);
    if (terminalStatuses.has(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function cancelTask(
  managementApiUrl: string,
  projectRef: string,
  taskId: string,
  accessToken: string,
) {
  const response = await fetch(
    `${managementApiUrl}/v1/projects/${projectRef}/tasks/${taskId}/cancel`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to cancel task: ${response.status}`);
  }

  return response.json();
}

export async function listDlq(
  managementApiUrl: string,
  projectRef: string,
  accessToken: string,
) {
  const response = await fetch(
    `${managementApiUrl}/v1/projects/${projectRef}/tasks/dlq`,
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch DLQ: ${response.status}`);
  }

  return response.json();
}

export async function retryTask(
  managementApiUrl: string,
  projectRef: string,
  taskId: string,
  accessToken: string,
) {
  const response = await fetch(
    `${managementApiUrl}/v1/projects/${projectRef}/tasks/${taskId}/retry`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to retry task: ${response.status}`);
  }

  return response.json();
}
