# Background Functions API Reference

This reference documents the SupaCloud-specific contract layered on top of the standard `supabase.functions.invoke()` flow.

Use this page together with:

- [Background Functions](./background-functions.md)
- [Background Functions With supabase-js](./background-functions-supabase-js-tutorial.md)
- [supabase-js-background-task-client.ts](./examples/supabase-js-background-task-client.ts)

## Recommended Integration Pattern

For JavaScript tenants, the recommended production pattern is:

1. keep using the official `supabase.functions.invoke()`
2. enable background mode through function config `background_routes`
3. use task APIs or Realtime to observe status changes

This keeps your integration compatible with stock `supabase-js` while letting SupaCloud decide, server-side, which heavy paths must be persisted and retried as background work.

## Invocation Request

Background mode is enabled through function config:

```json
{
  "verify_jwt": false,
  "background_routes": [
    "/generate/crop",
    "/generate/matting"
  ]
}
```

When a request path matches a configured `background_routes` entry, SupaCloud enqueues the task automatically.

This is the preferred integration model for browser and app clients.

## Enqueue Response

When the function is accepted for background execution, the response is:

- HTTP status: `202 Accepted`
- JSON body:

```json
{
  "task_id": "tsk_98fbn2...",
  "status": "enqueued"
}
```

## Task Status Model

### `pending`

- persisted but not yet leased by a worker

### `leased`

- claimed by a worker and reserved for execution

### `running`

- currently executing inside the background runtime

### `retry_scheduled`

- a previous attempt failed and the next attempt is scheduled

### `succeeded`

- execution completed successfully

### `failed`

- terminal failure without DLQ escalation

### `dead_lettered`

- maximum attempts were exhausted and the task moved to DLQ

### `cancelled`

- task was cancelled before or during execution

## Delivery Semantics

Background Functions use:

- persistent queueing
- bounded execution
- `at-least-once` delivery

They do **not** promise `exactly-once`.

Tenant handlers should therefore be:

- idempotent
- retry-safe
- cancellation-aware

## Realtime Observation Model

Task enqueue and task observation are different responsibilities:

- enqueue: `POST /functions/v1/...`
- observe: Realtime or task polling

SupaCloud recommends:

1. create the task through `functions.invoke()`
2. observe status through Realtime
3. fall back to polling when Realtime is unavailable

Realtime transport problems should not change the enqueue contract:

- accepted background requests still return `202 Accepted`
- task processing still runs through the background worker
- only the freshness of status delivery changes

## Runtime Metadata Exposed To Functions

During background execution, the runtime injects:

- `SUPACLOUD_BACKGROUND_TASK_ID`
- `SUPACLOUD_BACKGROUND_ATTEMPT`
- `SUPACLOUD_CANCELLATION_SIGNAL=supported`

The function also receives a normal `Request` whose `signal` is aborted when the task is cancelled.

## Cancellation Semantics

Cancellation is cooperative first, forceful second.

Flow:

1. control plane receives a cancel request
2. runtime aborts the active request signal
3. tenant function gets a chance to stop
4. if it does not stop in time, the worker is recycled

Tenant recommendation:

```ts
req.signal.throwIfAborted?.();
req.signal.addEventListener("abort", onAbort, { once: true });
```

## Task Detail Shape

Typical task detail fields:

```json
{
  "id": "tsk_98fbn2...",
  "project_ref": "abcd1234",
  "task_type": "edge_function",
  "function_slug": "video-transcode",
  "function_version": 7,
  "status": "running",
  "attempt": 1,
  "max_attempts": 3,
  "timeout_sec": 300,
  "error": null,
  "result": null,
  "attempts": []
}
```

## Attempt Detail Shape

Each task can contain multiple attempts:

```json
{
  "attempt_no": 1,
  "status": "retry_scheduled",
  "started_at": "2026-04-17T12:00:00.000Z",
  "completed_at": "2026-04-17T12:00:25.000Z",
  "duration_ms": 25000,
  "response_status": 500,
  "error": "Background function returned HTTP 500",
  "logs": [
    {
      "timestamp": "2026-04-17T12:00:05.000Z",
      "stream": "stdout",
      "level": "info",
      "message": "step=1"
    }
  ]
}
```

## Control Plane Endpoints

These endpoints are typically used by your trusted backend or admin UI, not by untrusted browsers.

### Get Task

```http
GET /v1/projects/:ref/tasks/:taskId
```

### List Tasks

```http
GET /v1/projects/:ref/tasks
```

Supported query parameters:

- `status`
- `task_type`
- `dlq`
- `limit`
- `summary=true`: return lightweight task rows for list views. Heavy `payload` and `result` columns are omitted from the list response; use `GET /v1/projects/:ref/tasks/:taskId` when full task detail is needed.

### Cancel Task

```http
POST /v1/projects/:ref/tasks/:taskId/cancel
```

### Retry Task

```http
POST /v1/projects/:ref/tasks/:taskId/retry
```

### List DLQ

```http
GET /v1/projects/:ref/tasks/dlq
```

`summary=true` is also supported on the DLQ list endpoint.

### Get Background Settings

```http
GET /v1/projects/:ref/tasks/settings/background
```

### Update Background Settings

```http
PATCH /v1/projects/:ref/tasks/settings/background
```

### Get Task Stats

```http
GET /v1/projects/:ref/tasks/stats
```

## Project-Level Background Settings

The project background task config controls:

- `concurrency`
- `max_attempts`
- `max_payload_bytes`
- `timeout_sec_default`
- `timeout_sec_max`

These project-level limits remain authoritative for all background routes.

## Error Handling Guidance

### Enqueue Errors

Treat these separately from business failures:

- SDK transport error
- relay/gateway error
- validation or auth error before enqueue

### Execution Errors

These appear after enqueue and should be inspected through task detail:

- task `error`
- attempt `error`
- `response_status`
- `stdout/stderr` logs

### DLQ Troubleshooting Order

Recommended order:

1. inspect latest task error
2. inspect attempt history
3. inspect logs
4. verify idempotency
5. retry only after fixing the root cause

## Large Payload Guidance

Do not treat background tasks as unlimited payload transport.

Recommended pattern:

1. upload large data to Storage
2. enqueue a small JSON payload
3. pass only object keys, URLs, or identifiers into the function

## Best-Practice Summary

- keep using official `supabase-js`
- activate background mode with `background_routes`
- wrap the pattern in your own `invokeAsync()` helper
- always use idempotency for side effects
- watch `req.signal` in long-running functions
- use control-plane APIs for polling, cancel, retry, and DLQ inspection
