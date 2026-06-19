export type FunctionTaskRecord = {
  id: string;
  status: string;
  function_slug: string | null;
  function_version?: string | null;
  attempt: number | null;
  max_attempts: number | null;
  error: string | null;
  updated_at: string;
  created_at: string;
  latest_logs?: Array<{
    timestamp: string;
    stream: "stdout" | "stderr";
    level: string;
    message: string;
  }>;
};

export function buildInvokeAsyncExample(slug: string) {
  return `const task = await invokeAsync(supabase, "${slug}", {
  body: {
    job_id: "job_123",
    input: "replace-me",
  },
  retries: 3,
  timeoutSec: 300,
  idempotencyKey: "${slug}-job_123-v1",
});

console.log(task);
// { task_id: "tsk_...", status: "enqueued" }`;
}

export function buildCurlExample(slug: string) {
  return `curl -X POST "\${SUPABASE_URL}/functions/v1/${slug}/generate" \\
  -H "Authorization: Bearer \${SUPABASE_ANON_KEY}" \\
  -H "apikey: \${SUPABASE_ANON_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "job_id": "job_123",
    "input": "replace-me"
  }'`;
}

export function buildJsInvokeExample(slug: string) {
  return `const { data, error } = await supabase.functions.invoke("${slug}", {
  body: {
    job_id: "job_123",
    input: "replace-me",
  },
});

if (error) throw error;
console.log(data);`;
}

export function buildTsInvokeExample(slug: string) {
  return `type AsyncTaskResponse = {
  task_id: string;
  status: "enqueued";
};

const { data, error } = await supabase.functions.invoke("${slug}", {
  body: {
    job_id: "job_123",
    input: "replace-me",
  },
});

if (error) throw error;

const task = data as AsyncTaskResponse;
console.log(task.task_id);`;
}

export function getStatusBadgeClass(status: string) {
  switch (status) {
    case "running":
    case "leased":
      return "text-blue-700 bg-blue-500/10 border-blue-500/20";
    case "retry_scheduled":
      return "text-amber-700 bg-amber-500/10 border-amber-500/20";
    case "succeeded":
      return "text-green-700 bg-green-500/10 border-green-500/20";
    case "dead_lettered":
    case "failed":
      return "text-red-700 bg-red-500/10 border-red-500/20";
    case "cancelled":
      return "text-slate-700 bg-slate-500/10 border-slate-500/20";
    default:
      return "text-muted-foreground bg-muted/40 border-border/60";
  }
}

export function buildFunctionTasksPath(
  projectRef: string,
  slug: string,
  limit = 8,
  version?: string | null,
) {
  const query = new URLSearchParams({
    function_slug: slug,
    limit: String(limit),
  });

  if (version) {
    query.set("function_version", version);
  }

  return `/v1/projects/${projectRef}/tasks?${query.toString()}`;
}

export function buildFunctionTaskConsolePath(
  projectRef: string,
  slug: string,
  taskId?: string,
) {
  const query = new URLSearchParams({
    function_slug: slug,
  });

  if (taskId) {
    query.set("task_id", taskId);
  }

  return `/project/${projectRef}/tasks?${query.toString()}`;
}
