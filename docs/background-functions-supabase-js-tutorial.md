# Background Functions With `supabase-js`

This guide shows the tenant-facing integration flow for SupaCloud Background Functions using the standard `supabase-js` client plus a thin helper layer.

It covers:

- async invocation
- task polling
- task cancellation
- DLQ troubleshooting

## Short Answer: Can This Be Done With `supabase-js`?

Yes, with one important distinction:

- `supabase.functions.invoke()` already supports custom `headers`, `body`, `method`, and other fetch-like options
- SupaCloud's background execution mode is activated by `x-supacloud-*` headers
- official `supabase-js` does **not** currently expose a first-class `async: true` option in the documented `invoke()` API

So the practical integration pattern is:

1. use stock `supabase.functions.invoke()`
2. pass SupaCloud async headers
3. wrap that in your own `invokeAsync()` helper for ergonomics

That is the recommended integration for SupaCloud tenants because it preserves compatibility with the official SDK instead of depending on a forked client or undocumented client patch.

## Architecture Boundary

There are two different clients in this tutorial:

### App Client

Used by your frontend or app server to enqueue background work through `supabase.functions.invoke()`.

### Control Plane Client

Used by your trusted backend, admin panel, or platform tooling to:

- read task status
- cancel tasks
- retry DLQ items
- inspect attempts and logs

Do not expose control-plane admin credentials directly in the browser.

## Step 1: Create A Small Async Helper

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

type InvokeAsyncOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  retries?: number;
  timeoutSec?: number;
  idempotencyKey?: string;
  method?: string;
};

export async function invokeAsync(
  supabase: SupabaseClient,
  functionName: string,
  options: InvokeAsyncOptions = {},
) {
  const { body, headers = {}, retries, timeoutSec, idempotencyKey, method } = options;

  const { data, error } = await supabase.functions.invoke(functionName, {
    body,
    method,
    headers: {
      ...headers,
      "x-supacloud-async": "true",
      ...(retries !== undefined ? { "x-supacloud-retries": String(retries) } : {}),
      ...(timeoutSec !== undefined ? { "x-supacloud-timeout": String(timeoutSec) } : {}),
      ...(idempotencyKey
        ? { "x-supacloud-idempotency-key": idempotencyKey }
        : {}),
    },
  });

  if (error) throw error;

  return data as {
    task_id: string;
    status: "enqueued";
  };
}
```

This helper is intentionally small. The goal is not to replace `supabase-js`, but to keep the official client as the transport layer and add only the SupaCloud-specific headers that switch execution into background mode.

## Step 2: Enqueue A Background Function

```ts
const task = await invokeAsync(supabase, "mockup-generator", {
  body: {
    product_id: "prod_123",
    image_url: "https://example.com/source.png",
  },
  retries: 3,
  timeoutSec: 300,
  idempotencyKey: "mockup-prod_123-v1",
});

console.log(task.task_id);
```

Expected response:

```json
{
  "task_id": "tsk_98fbn2...",
  "status": "enqueued"
}
```

## Step 3: Poll Task Status

Task polling is a control-plane concern, so this call should usually come from your trusted backend or admin UI.

```ts
type TaskAttempt = {
  attempt_no: number;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  response_status: number | null;
  error: string | null;
  logs: Array<{
    timestamp: string;
    stream: "stdout" | "stderr";
    level: string;
    message: string;
  }>;
};

type TaskDetail = {
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

async function getTask(
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
```

Simple polling helper:

```ts
const terminalStatuses = new Set([
  "succeeded",
  "failed",
  "dead_lettered",
  "cancelled",
]);

export async function waitForTask(
  managementApiUrl: string,
  projectRef: string,
  taskId: string,
  accessToken: string,
  intervalMs = 2000,
) {
  while (true) {
    const task = await getTask(managementApiUrl, projectRef, taskId, accessToken);

    if (terminalStatuses.has(task.status)) {
      return task;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
```

## Step 4: Cancel A Running Task

If the task is no longer needed, cancel it through the control plane:

```ts
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
```

On the function side, SupaCloud will abort `req.signal` before forcefully recycling the worker. That means your handler should watch `req.signal` and stop expensive work quickly.

See:

- [Background Functions](./background-functions.md)
- [cancellable-background-function.ts](./examples/cancellable-background-function.ts)

## Step 5: Inspect DLQ And Retry

If the task reaches `dead_lettered`, list DLQ items:

```ts
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
```

Retry a dead-lettered task:

```ts
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
```

## Full Tutorial Flow

Putting it together:

```ts
const task = await invokeAsync(supabase, "mockup-generator", {
  body: {
    product_id: "prod_123",
    image_url: "https://example.com/source.png",
  },
  retries: 3,
  timeoutSec: 300,
  idempotencyKey: "mockup-prod_123-v1",
});

const finalTask = await waitForTask(
  process.env.SUPACLOUD_MANAGEMENT_API_URL!,
  process.env.SUPACLOUD_PROJECT_REF!,
  task.task_id,
  process.env.SUPACLOUD_MANAGEMENT_TOKEN!,
);

switch (finalTask.status) {
  case "succeeded":
    console.log("Task finished:", finalTask.result);
    break;
  case "cancelled":
    console.log("Task was cancelled");
    break;
  case "dead_lettered":
    console.error("Task moved to DLQ:", finalTask.error);
    console.table(finalTask.attempts);
    break;
  default:
    console.error("Task failed:", finalTask.status, finalTask.error);
}
```

## Recommended Error-Handling Strategy

### At Enqueue Time

- treat invoke transport errors separately from function business errors
- always set an idempotency key for side-effecting work

### During Polling

- stop polling once the task reaches a terminal status
- surface the latest attempt error and recent logs

### For DLQ

- inspect `attempts`
- inspect `stdout/stderr` logs
- fix the underlying issue
- use manual retry only after the cause is understood

## Common DLQ Root Causes

### 1. Duplicate Side Effects

Cause:

- the handler is retried
- the handler is not idempotent

Fix:

- use `x-supacloud-idempotency-key`
- make writes idempotent in Postgres or your application layer

### 2. External API Timeout

Cause:

- long or unstable third-party dependency

Fix:

- increase `x-supacloud-timeout` within project limits
- checkpoint partial progress
- watch `req.signal` so cancellation exits quickly

### 3. Payload Too Large

Cause:

- large request body persisted directly into the task

Fix:

- upload the large object to Storage first
- pass only a storage key, URL, or object reference

### 4. Cancellation Ignored

Cause:

- function never checks `req.signal`

Fix:

- call `req.signal.throwIfAborted?.()`
- attach an `abort` listener for waits, streams, and polling loops

## Recommendation For SupaCloud Tenants

If you want `functions.invoke(async)` ergonomics, implement it as your own helper rather than waiting on upstream SDK changes.

That gives you:

- full compatibility with stock `supabase-js`
- a clean tenant-facing API
- no fork of the official SDK

See the complete helper example here:

- [supabase-js-background-task-client.ts](./examples/supabase-js-background-task-client.ts)
- [Background Functions API Reference](./background-functions-api-reference.md)
