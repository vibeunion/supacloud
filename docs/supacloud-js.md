# `@supacloud/js`

`@supacloud/js` is the official SupaCloud platform SDK built on top of `@supabase/supabase-js`.

It exists for one reason: SupaCloud now has platform semantics that go beyond stock Supabase transport primitives, and business apps should not have to reimplement that glue repeatedly.

Examples:

- background task enqueue
- task detail and retry APIs
- task cancellation
- Realtime status subscription with polling fallback
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
