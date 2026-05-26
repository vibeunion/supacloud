# `@supacloud/js`

`@supacloud/js` is the platform SDK for SupaCloud.

It does **not** replace [`@supabase/supabase-js`](https://www.npmjs.com/package/@supabase/supabase-js). Instead, it wraps a normal Supabase client and adds SupaCloud-specific capabilities such as:

- background task submission
- task detail and list APIs
- cancel / retry helpers
- Realtime subscription with polling fallback
- queue send / receive / ack / release / fail / retry / delete / list / listFailed / stats / settings helpers
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
- `queue(name).send`
- `queue(name).receive`
- `queue(name).ack`
- `queue(name).release`
- `queue(name).fail`
- `queue(name).retry`
- `queue(name).delete`
- `queue(name).list`
- `queue(name).listFailed`
- `queue(name).stats`
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

```ts
const queue = supacloud.queue("emails");

const message = await queue.send(
  { to: "user@example.com", template: "welcome" },
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

const leased = await queue.receive({ visibilityTimeoutSec: 60 });
if (leased) {
  try {
    await sendEmail(leased.payload);
    await queue.ack(leased.id, { delivered: true });
  } catch (error) {
    await queue.release(leased.id, { delayMs: 30_000, error: String(error) });
  }
}

const stats = await queue.stats();
console.log(stats.inFlight, stats.deadLettered);
```

Queue API surface:

- `queue.send(payload, options)`: enqueue a message, optionally delayed and idempotent
- `queue.receive({ visibilityTimeoutSec })`: lease the next message, or return `null`
- `queue.ack(messageId, result)`: mark the leased message succeeded
- `queue.release(messageId, { delayMs, error })`: return the message to the queue later
- `queue.fail(messageId, { error, deadLetter })`: mark failed or dead-lettered
- `queue.retry(messageId)`: replay a dead-lettered message
- `queue.delete(messageId)`: cancel/delete a message
- `queue.list(filters)`: list messages by status, DLQ flag, and limit
- `queue.listFailed(limit)`: shortcut for DLQ messages
- `queue.get(messageId)`: read message detail, attempts, and latest logs
- `queue.stats()`: inspect queue depth and recent success/failure counts
- `queue.getSettings()`: read concurrency, lease, retry, and rate-limit settings
- `queue.updateSettings(settings)`: patch queue settings

Queue settings:

- `max_in_flight`: max concurrently leased/running messages for this queue
- `default_visibility_timeout_sec`: lease timeout used by `receive()`
- `max_attempts`: default retry budget for new messages
- `rate_limit_per_minute`: producer enqueue limit

Queue conflicts such as replaying a non-DLQ message are surfaced as `SupaCloudApiError` with `status`, `code`, and `responseBody`, so callers do not need to parse raw `fetch` responses.

## OAuth/OIDC Helpers

`client.auth.oauthServer` is the SupaCloud SDK surface for project-scoped OAuth 2.1 / OIDC migration and discovery.

It does **not** take a global account scope. The SDK always sends the normal Management API Bearer token and lets the server enforce project ownership.
