# `@supacloud/js`

`@supacloud/js` is the platform SDK for SupaCloud.

It does **not** replace [`@supabase/supabase-js`](https://www.npmjs.com/package/@supabase/supabase-js). Instead, it wraps a normal Supabase client and adds SupaCloud-specific capabilities such as:

- background task submission
- task detail and list APIs
- cancel / retry helpers
- Realtime subscription with polling fallback
- queue send / receive / ack / release / fail / retry / delete / list / listFailed / stats / settings helpers
- project OAuth/OIDC migration and OAuth client management

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
});

const finalState = await task.wait();
console.log(finalState.status);
```

## Design

This SDK is intentionally thin:

- `supabase-js` still owns auth, storage, database, Realtime transport, and plain function invokes
- `@supacloud/js` owns SupaCloud platform semantics layered on top of that transport

`tasks.submit()` expects the target function path to be configured in `background_routes`.
That keeps frontend calls compatible with strict CORS deployments while preserving the same task receipt API.

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

## Status Subscription

`tasks.subscribe()` uses this strategy:

1. try `postgres_changes` on `public.tasks`
2. if Realtime is unavailable, fall back to polling the management API

This lets apps degrade gracefully when websocket or channel health is transient.

## Queue Helpers

```ts
const queue = supacloud.queue("emails");

const message = await queue.send(
  { to: "user@example.com", template: "welcome" },
  {
    idempotencyKey: "welcome-user-123",
    correlationId: "signup-123",
    businessTaskId: "email-job-123",
    metadata: { source: "signup" },
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

Queue conflicts such as replaying a non-DLQ message are surfaced as `SupaCloudApiError` with `status`, `code`, and `responseBody`, so callers do not need to parse raw `fetch` responses.

## OAuth/OIDC Helpers

`client.auth.oauthServer` is the SupaCloud SDK surface for project-scoped OAuth 2.1 / OIDC migration and discovery.

It does **not** take a global account scope. The SDK always sends the normal Management API Bearer token and lets the server enforce project ownership.
