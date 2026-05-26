# `@supacloud/js`

`@supacloud/js` is the platform SDK for SupaCloud.

It does **not** replace [`@supabase/supabase-js`](https://www.npmjs.com/package/@supabase/supabase-js). Instead, it wraps a normal Supabase client and adds SupaCloud-specific capabilities such as:

- background task submission
- task detail and list APIs
- cancel / retry helpers
- Realtime subscription with polling fallback
- Supabase Queues helpers backed by the official `pgmq_public` RPC API, plus SupaCloud management extensions for queue administration and diagnostics
- project OAuth/OIDC migration and OAuth client management
- SupAuth provisioning and runtime verification helpers

## Install

```bash
npm install @supacloud/js @supabase/supabase-js
```

## Quick Start

```ts
import { createClient } from "@supabase/supabase-js";
import { createSupaCloudClient } from "@supacloud/js";

const supabase = createClient("https://api.example.com", "anon-key");

const supacloud = createSupaCloudClient({
  supabase,
  managementApiUrl: "https://admin.example.com",
  projectRef: "abcd1234",
});

const task = await supacloud.tasks.submit("aorist-ai/generate/crop", {
  body: { image_id: "img_123" },
  idempotencyKey: "crop-img_123-v1",
  correlationId: "workflow-run-123",
  businessTaskId: "aorist-task-123",
  metadata: {
    workflow_id: "workflow-123",
    billing_subject: "user-123",
  },
});

const finalState = await task.wait();
console.log(finalState.status);
```

## SupAuth Management

`supacloud.supauth` is a management-plane helper for provisioning and verifying a SupAuth/SupaOAuth runtime on SupaCloud. It is intended for trusted server-side tools, CI jobs, or admin backends that can call the SupaCloud Management API.

```ts
const supacloud = createSupaCloudClient({
  supabase,
  managementApiUrl: "https://admin.example.com",
  projectRef: "abcd1234",
  getAccessToken: () => process.env.SUPACLOUD_MANAGEMENT_TOKEN ?? null,
});

await supacloud.supauth.provision({
  authDomain: "auth.example.com",
  apiDomain: "api.example.com",
  adminMode: "sso",
  storageBuckets: [{ id: "avatars", public: true }],
});

await supacloud.supauth.reconcile({ dryRun: false });

const health = await supacloud.supauth.verify();
if (!health.healthy) {
  throw new Error("SupAuth runtime is not healthy");
}

const config = await supacloud.supauth.getClientConfig();
console.log(config.authUrl);
```

The helper maps to these SupaCloud Management API routes:

- `POST /v1/projects/:projectRef/supauth/provision`
- `POST /v1/projects/:projectRef/supauth/reconcile`
- `POST /v1/projects/:projectRef/supauth/rollback`
- `GET /v1/projects/:projectRef/supauth/client-config`
- `GET /v1/projects/:projectRef/supauth/verify`

Boundary:

- Use `@supacloud/js` for SupaCloud-owned infrastructure orchestration: GoTrue env injection, restart/reconcile, Kong route setup, runtime health checks, and public client config discovery.
- Use `@supabase/supabase-js` for normal application runtime calls: auth session, database, storage, realtime, and edge functions.
- Use the SupaOAuth product SDK or Management API for SupaOAuth-owned resources: applications, connectors, organizations, roles, permissions, audit logs, and webhooks.
- Do not expose SupaCloud Management API credentials in browser code.

## Design

This SDK is intentionally thin:

- `supabase-js` still owns auth, storage, database, Realtime transport, and plain function invokes
- `@supacloud/js` owns SupaCloud platform semantics layered on top of that transport

`tasks.submit()` expects the target function path to be configured in `background_routes`.
That keeps frontend calls compatible with strict CORS deployments while preserving the same task receipt API.

Use `correlationId`, `businessTaskId`, and `metadata` when the application already has its own task, workflow, or billing records. SupaCloud stores these fields but does not interpret them; lifecycle webhooks echo them back so the application can update its own tables.

The current package focuses on:

- `tasks.submit`
- `tasks.get`
- `tasks.list`
- `tasks.listDlq`
- `tasks.cancel`
- `tasks.retry`
- `tasks.wait`
- `tasks.subscribe`
- `queues.list`
- `queues.create`
- `queues.drop`
- `queue(name).send`
- `queue(name).sendBatch`
- `queue(name).read`
- `queue(name).receive`
- `queue(name).pop`
- `queue(name).archive`
- `queue(name).ack`
- `queue(name).delete`
- `queue(name).release`
- `queue(name).list`
- `queue(name).listArchived`
- `queue(name).stats`
- `queue(name).purge`
- `queue(name).getSettings`
- `queue(name).updateSettings`
- `auth.oauthServer.getStatus`
- `auth.oauthServer.migrateToOidc`
- `auth.oauthServer.getDiscovery`
- `auth.oauthServer.getJwks`
- `auth.oauthServer.buildAuthorizeUrl`
- `auth.oauthClients.list/create/get/update/delete/regenerateSecret`
- `supauth.provision`
- `supauth.reconcile`
- `supauth.rollback`
- `supauth.getClientConfig`
- `supauth.verify`

## Status Subscription

`tasks.subscribe()` uses this strategy:

1. try `postgres_changes` on `public.tasks`
2. if Realtime is unavailable, fall back to polling the management API

This lets apps degrade gracefully when websocket or channel health is transient.

## Task Lifecycle Webhook

Applications that already own a business task table should keep it. SupaCloud emits lifecycle events so the app can sync `public.tasks`, billing, Realtime, and workflow rows without adopting platform-internal mirror tables.

Register a webhook from a trusted backend:

```http
POST /v1/projects/:ref/task-events/webhook
Authorization: Bearer <management-token>
Content-Type: application/json

{
  "url": "https://app.example.com/supacloud/task-events",
  "secret": "shared-hmac-secret"
}
```

Events are delivered as `{ events: [...] }`. Each event includes `event_type`, `task_id`, `status`, `attempt`, `correlation_id`, `business_task_id`, and `metadata`.

Supported lifecycle events:

- `task.created`
- `task.running`
- `task.succeeded`
- `task.failed`
- `task.retry_scheduled`
- `task.dead_lettered`
- `task.cancelled`

If `secret` is set, verify `X-SupaCloud-Signature: sha256=<hmac>` against the raw JSON body.

## Queue Helpers

The core message operations use the official Supabase Queues API exposed through `pgmq_public`:

- `pgmq_public.send(queue_name, message, sleep_seconds)`
- `pgmq_public.send_batch(queue_name, messages, sleep_seconds)`
- `pgmq_public.read(queue_name, sleep_seconds, n)`
- `pgmq_public.pop(queue_name)`
- `pgmq_public.archive(queue_name, message_id)`
- `pgmq_public.delete(queue_name, message_id)`

These calls go through your wrapped `supabase` client as `supabase.schema('pgmq_public').rpc(...)`. Queue creation/drop, queue listing, metrics, purge, settings, diagnostics, and visibility-timeout adjustment are SupaCloud management extensions because Supabase's public Queue API intentionally does not expose those as client-side RPCs.

```ts
const queue = supacloud.queue("emails");

const message = await queue.send(
  { to: "user@example.com", template: "welcome" },
  {
    sleepSeconds: 10,
  },
);

const leased = await queue.receive({ visibilityTimeoutSec: 60 });
if (leased) {
  try {
    await sendEmail(leased.payload);
    await queue.ack(leased.msg_id);
  } catch (error) {
    await queue.release(leased.msg_id, { delayMs: 30_000, error: String(error) });
  }
}

const stats = await queue.stats();
console.log(stats.queue_length, stats.oldest_msg_age_sec);
```

Queue API surface:

- `queue.send(payload, { sleepSeconds })`: enqueue one message through `pgmq_public.send`
- `queue.sendBatch(messages, { sleepSeconds })`: enqueue messages through `pgmq_public.send_batch`
- `queue.read({ sleepSeconds, n })`: read up to `n` messages through `pgmq_public.read`
- `queue.receive({ visibilityTimeoutSec })`: compatibility shortcut for `read({ n: 1 })`
- `queue.pop()`: read and delete the next message through `pgmq_public.pop`
- `queue.archive(messageId)` / `queue.ack(messageId)`: archive a message through `pgmq_public.archive`
- `queue.delete(messageId)`: delete a message through `pgmq_public.delete`
- `queue.release(messageId, { sleepSeconds | delayMs })`: SupaCloud extension for `pgmq.set_vt`
- `queue.list(filters)`: SupaCloud diagnostic extension for queue/archive table inspection
- `queue.listArchived(limit)`: SupaCloud diagnostic shortcut for archived messages
- `queue.stats()`: SupaCloud extension for `pgmq.metrics`
- `queue.purge()`: SupaCloud extension for `pgmq.purge_queue`
- `queue.getSettings()`: read concurrency, lease, retry, and rate-limit settings
- `queue.updateSettings(settings)`: patch queue settings
- `supacloud.queues.list()`: list queues with `pgmq.list_queues`
- `supacloud.queues.create(name, { unlogged })`: create a basic or unlogged queue
- `supacloud.queues.drop(name)`: drop a queue

Queue settings:

- `max_in_flight`: max concurrently leased/running messages for this queue
- `default_visibility_timeout_sec`: lease timeout used by `receive()`
- `max_attempts`: application-level retry budget for SupaCloud consumers; PGMQ itself stores plain JSON messages
- `rate_limit_per_minute`: producer enqueue limit

Management extension conflicts are surfaced as `SupaCloudApiError` with `status`, `code`, and `responseBody`, so callers do not need to parse raw `fetch` responses.

## OAuth/OIDC Helpers

`client.auth.oauthServer` is the SupaCloud SDK surface for project-scoped OAuth 2.1 / OIDC migration and discovery.

It does **not** take a global account scope. The SDK always sends the normal Management API Bearer token and lets the server enforce project ownership.
