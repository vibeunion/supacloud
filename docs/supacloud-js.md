# `@supacloud/js`

`@supacloud/js` is the official SupaCloud platform SDK built on top of `@supabase/supabase-js`.

It exists for one reason: SupaCloud now has platform semantics that go beyond stock Supabase transport primitives, and business apps should not have to reimplement that glue repeatedly.

Examples:

- background task enqueue
- task detail and retry APIs
- task cancellation
- Realtime status subscription with polling fallback
- task lifecycle webhook correlation metadata
- message queue send / receive / ack / release / fail / retry APIs
- project-aware management API routing
- project OAuth/OIDC migration and OAuth client management

## Design Goal

`@supabase/supabase-js` should keep owning:

- auth
- database
- storage
- Realtime transport
- standard Edge Function invocation

`@supacloud/js` should own:

- SupaCloud task semantics
- control-plane task APIs
- platform-specific task observation and fallback behavior

In short:

- `supabase-js` is the transport and data SDK
- `@supacloud/js` is the platform enhancement layer

`client.tasks.submit(...)` assumes the invoked function path is already covered by the project's `background_routes`.
That keeps frontend calls compatible with strict CORS gateways without any special async headers.

## Package Shape

Current entrypoint:

```ts
import { createSupaCloudClient } from "@supacloud/js";
```

Current first-class API surface:

- `createSupaCloudClient(...)`
- `client.tasks.submit(...)`
- `client.tasks.get(...)`
- `client.tasks.list(...)`
- `client.tasks.cancel(...)`
- `client.tasks.retry(...)`
- `client.tasks.wait(...)`
- `client.tasks.subscribe(...)`
- `client.functions.invokeBackground(...)`
- `client.queue(name).send(...)`
- `client.queue(name).receive(...)`
- `client.queue(name).list(...)`
- `client.queue(name).listFailed(...)`
- `client.queue(name).get(...)`
- `client.queue(name).ack(...)`
- `client.queue(name).release(...)`
- `client.queue(name).fail(...)`
- `client.queue(name).retry(...)`
- `client.queue(name).delete(...)`
- `client.queue(name).stats(...)`
- `client.queue(name).getSettings(...)`
- `client.queue(name).updateSettings(...)`
- `client.auth.oauthServer.getStatus()`
- `client.auth.oauthServer.migrateToOidc()`
- `client.auth.oauthServer.getDiscovery()`
- `client.auth.oauthServer.getJwks()`
- `client.auth.oauthServer.buildAuthorizeUrl()`
- `client.auth.oauthClients.list()/create()/get()/update()/delete()/regenerateSecret()`

## Example

```ts
import { createClient } from "@supabase/supabase-js";
import { createSupaCloudClient } from "@supacloud/js";

const supabase = createClient("https://api.example.com", "anon-key");

const supacloud = createSupaCloudClient({
  supabase,
  managementApiUrl: "https://admin.example.com",
  projectRef: "77az24zz7p",
});

const task = await supacloud.tasks.submit("aorist-ai/generate/crop", {
  body: { image_id: "img_123" },
  timeoutSec: 300,
  retries: 2,
  idempotencyKey: "crop-img_123-v1",
  correlationId: "workflow-run-123",
  businessTaskId: "aorist-task-123",
  metadata: {
    workflow_id: "workflow-123",
    billing_subject: "user-123",
  },
});

const finalTask = await task.wait();
console.log(finalTask.status);
```

## AoristCross-Style Integration

For frontends that currently hand-roll:

- `functions.invoke(...)`
- task polling
- task cancellation
- Realtime fallback state

the migration shape is:

```ts
import { createSupaCloudClient } from "@supacloud/js";

const supacloud = createSupaCloudClient({
  supabase,
  managementApiUrl: "https://admin.aorist.net",
  projectRef: "77az24zz7p",
});

const task = await supacloud.tasks.submit("aorist-ai/generate/crop", {
  body: payload,
  idempotencyKey: `crop-${assetId}-v1`,
  timeoutSec: 300,
  retries: 2,
  correlationId: workflowRunId,
  businessTaskId: localTaskId,
  metadata: {
    workflow_id: workflowId,
    billing_subject: userId,
  },
});

const subscription = task.subscribe({
  onUpdate(snapshot) {
    store.applyTaskUpdate(snapshot);
  },
  onStateChange(state) {
    store.connectionState = state;
  },
});
```

This removes the need for each product codebase to keep its own:

- `invokeAsync(...)`
- `waitForTask(...)`
- `cancelTask(...)`
- `CHANNEL_ERROR -> polling` fallback logic

## Realtime Strategy

`client.tasks.subscribe()` is intentionally resilient:

1. try Supabase Realtime on `public.tasks`
2. if the channel becomes unavailable, switch to polling
3. keep task UX alive even when Realtime is degraded

This is important because task correctness should not depend on websocket health.

## Task Lifecycle Webhook

SupaCloud keeps platform execution state in `project_tasks` and internal mirror tables. Product databases can keep their own business tables such as `public.tasks`; they should sync by lifecycle events instead of adopting the platform mirror schema.

Register a project webhook from a trusted backend:

```http
POST /v1/projects/:ref/task-events/webhook
Authorization: Bearer <management-token>
Content-Type: application/json

{
  "url": "https://app.example.com/supacloud/task-events",
  "secret": "shared-hmac-secret"
}
```

Webhook calls contain:

```json
{
  "events": [
    {
      "event_type": "task.succeeded",
      "task_id": "tsk_123",
      "project_ref": "77az24zz7p",
      "task_type": "edge_function",
      "function_slug": "aorist-ai/generate/crop",
      "attempt": 1,
      "max_attempts": 3,
      "status": "succeeded",
      "error": null,
      "correlation_id": "workflow-run-123",
      "business_task_id": "aorist-task-123",
      "metadata": {
        "workflow_id": "workflow-123",
        "billing_subject": "user-123"
      },
      "timestamp": "2026-05-24T00:00:00.000Z"
    }
  ]
}
```

If a secret is configured, SupaCloud signs the JSON body with `X-SupaCloud-Signature: sha256=<hmac>`. Consumers should verify the HMAC, then update their own business tables by `business_task_id` or `correlation_id`.

Lifecycle event types:

- `task.created`
- `task.running`
- `task.succeeded`
- `task.failed`
- `task.retry_scheduled`
- `task.dead_lettered`
- `task.cancelled`

## Message Queues

Queues are project-scoped and built on the same `project_tasks` storage. Queue names may contain letters, numbers, `.`, `_`, and `-`, and are encoded by the SDK.

Producer:

```ts
const queue = supacloud.queue("emails");

const message = await queue.send(
  {
    to: "user@example.com",
    template: "welcome",
  },
  {
    idempotencyKey: "welcome-user-123",
    delayMs: 10_000,
    maxAttempts: 5,
    traceId: "trace-123",
    correlationId: "signup-123",
    businessTaskId: "email-job-123",
    metadata: {
      source: "signup",
      billing_subject: "user-123",
    },
  },
);
```

Consumer:

```ts
const leased = await queue.receive({ visibilityTimeoutSec: 60 });

if (leased) {
  try {
    await sendEmail(leased.payload);
    await queue.ack(leased.id, { delivered: true });
  } catch (error) {
    await queue.release(leased.id, {
      delayMs: 30_000,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
```

Failure and DLQ flow:

```ts
await queue.fail(leased.id, { error: "template_missing", deadLetter: true });

const failed = await queue.listFailed(100);
await queue.retry(failed[0].id);
await queue.delete(failed[0].id);
```

Operations:

```ts
const messages = await queue.list({ status: ["pending", "leased"], limit: 50 });
const message = await queue.get("msg_123");
const stats = await queue.stats();

const settings = await queue.getSettings();
await queue.updateSettings({
  max_in_flight: settings.max_in_flight,
  default_visibility_timeout_sec: 120,
  max_attempts: 5,
  rate_limit_per_minute: 1200,
});
```

Queue settings:

- `max_in_flight`: maximum concurrently leased/running messages for this queue
- `default_visibility_timeout_sec`: lease timeout used by `receive()` when no override is passed
- `max_attempts`: default retry budget for new messages
- `rate_limit_per_minute`: enqueue rate limit for producers

Terminal queue states should be treated like task states: `succeeded`, `failed`, `dead_lettered`, and `cancelled` are not in-flight.

## OAuth/OIDC Helpers

`client.auth.oauthServer` handles project-scoped OAuth 2.1 / OIDC migration, discovery, and client registration workflows.

The SDK stays account-isolated. It does not let callers supply a global account scope; it forwards the normal Management API Bearer token and the server decides project access.

## Why This Package Exists

Without `@supacloud/js`, every frontend ends up hand-writing the same glue:

- browser-safe background route invocation
- task status polling
- cancel/retry fetches
- Realtime-to-polling fallback
- project ref and management API URL wiring

That is exactly the kind of platform contract that should live in one maintained SDK instead of leaking into every product codebase.
