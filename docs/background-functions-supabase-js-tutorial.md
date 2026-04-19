# Background Functions With `supabase-js`

This guide shows the tenant-facing integration flow for SupaCloud Background Functions using the standard `supabase-js` client plus `@supacloud/js`.

It covers:

- async invocation
- task polling
- task cancellation
- DLQ troubleshooting

## Short Answer: Can This Be Done With `supabase-js`?

Yes, with one important distinction:

- `supabase.functions.invoke()` already supports custom `headers`, `body`, `method`, and other fetch-like options
- on browsers, the safest pattern is to invoke a function path already listed in `background_routes`

So the practical integration pattern is:

1. use stock `supabase.functions.invoke()`
2. let `@supacloud/js` wrap SupaCloud task semantics for you

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

## Step 1: Create A SupaCloud Client

```ts
import { createClient } from "@supabase/supabase-js";
import { createSupaCloudClient } from "@supacloud/js";

const supabase = createClient("https://api.example.com", "anon-key");

const supacloud = createSupaCloudClient({
  supabase,
  managementApiUrl: "https://admin.example.com",
  projectRef: "abcd1234",
});
```

`@supacloud/js` does not replace `supabase-js`. It layers SupaCloud task semantics on top of it so app teams do not need to keep rewriting the same helper code.

## Step 2: Enqueue A Background Function

```ts
const task = await supacloud.tasks.submit("mockup-generator", {
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

Task polling is still a control-plane concern, so this call should usually come from your trusted backend or admin UI.

```ts
const detail = await task.get();
```

Simple waiting helper:

```ts
const finalTask = await task.wait({ intervalMs: 2000 });
```

## Step 4: Cancel A Running Task

If the task is no longer needed, cancel it through the control plane:

```ts
await task.cancel();
```

On the function side, SupaCloud will abort `req.signal` before forcefully recycling the worker. That means your handler should watch `req.signal` and stop expensive work quickly.

See:

- [Background Functions](./background-functions.md)
- [cancellable-background-function.ts](./examples/cancellable-background-function.ts)

## Step 5: Inspect DLQ And Retry

If the task reaches `dead_lettered`, list DLQ items:

```ts
const dlq = await supacloud.tasks.listDlq();
```

Retry a dead-lettered task:

```ts
await supacloud.tasks.retry(task.taskId);
```

## Step 6: Subscribe With Realtime Fallback

```ts
const subscription = task.subscribe({
  onUpdate(snapshot) {
    console.log(snapshot.status, snapshot.progress);
  },
  onStateChange(state) {
    console.log("connection", state);
  },
});

// later
subscription.unsubscribe();
```

`@supacloud/js` will:

1. try `postgres_changes` on `public.tasks`
2. switch to polling if the channel times out or errors

This keeps task UX alive even when Realtime is degraded.

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

- use a stable idempotency key when the caller is a trusted backend
- make writes idempotent in Postgres or your application layer

### 2. External API Timeout

Cause:

- long or unstable third-party dependency

Fix:

- increase the task timeout from a trusted backend or raise the project default within configured limits
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
Point that helper at a path covered by `background_routes` instead of sending custom async headers.

That gives you:

- full compatibility with stock `supabase-js`
- a clean tenant-facing API
- no fork of the official SDK

See the complete helper example here:

- [supabase-js-background-task-client.ts](./examples/supabase-js-background-task-client.ts)
- [Background Functions API Reference](./background-functions-api-reference.md)
