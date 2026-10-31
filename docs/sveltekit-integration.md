# SvelteKit Integration

This is a reference integration, not a default SvelteKit host and not a second
business layer. Keep the existing application command boundary (RPC, command
gateway or generated client) and use SvelteKit only for request-scoped clients,
read snapshots, server actions and route composition.

## Ownership

| Concern | Owner |
| --- | --- |
| Supabase session, CRUD, Storage and Realtime | Existing `@supabase/supabase-js` client |
| SupaCloud task submission, status and authorized actions | `@supacloud/js` |
| Business validation, tenant, idempotency, audit and receipts | Trusted application server / database |
| Svelte component lifetime and command scopes | `@supacloud/app-svelte` |
| Routing, forms, SSR and query cache | SvelteKit and the application |
| UI, tables and page state | The application UI (for example svadmin) |

Do not add a second HTTP/session implementation, a second command runtime or a
new default meta-framework package. `@supacloud/app` remains backend metadata,
DI and command governance; it is not a SvelteKit host.

## Per-request clients

Create the Supabase and SupaCloud clients inside the request, never in a
module-level server singleton. The example uses `@supabase/ssr` for cookie
sessions; install it separately from the SDK.

```ts
// src/hooks.server.ts
import { createServerClient } from "@supabase/ssr";
import { createSupaCloudClient } from "@supacloud/js";
import { env as privateEnv } from "$env/dynamic/private";
import { env as publicEnv } from "$env/dynamic/public";
import type { Handle } from "@sveltejs/kit";

export const handle: Handle = async ({ event, resolve }) => {
  const supabase = createServerClient(
    publicEnv.PUBLIC_SUPABASE_URL,
    publicEnv.PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => event.cookies.getAll(),
        setAll: (cookies) => {
          for (const { name, value, options } of cookies) {
            event.cookies.set(name, value, { ...options, path: "/" });
          }
        },
      },
    },
  );

  const supacloud = createSupaCloudClient({
    supabase,
    managementApiUrl: privateEnv.SUPACLOUD_MANAGEMENT_URL,
    projectRef: privateEnv.SUPACLOUD_PROJECT_REF,
    getAccessToken: async () => {
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token ?? null;
    },
  });

  event.locals.supabase = supabase;
  event.locals.supacloud = supacloud;

  return resolve(event);
};
```

The Management API URL and project reference are fixed configuration, not user
input. Use only task endpoints that authorize the current user. Keep service-role
commands and privileged Management API operations on the trusted server.

Declare the request locals once:

```ts
// src/app.d.ts
declare global {
  namespace App {
    interface Locals {
      supabase: import("@supabase/supabase-js").SupabaseClient;
      supacloud: ReturnType<typeof import("@supacloud/js").createSupaCloudClient>;
    }
  }
}

export {};
```

## Read pages: SSR snapshot only

A read page may render the last known task snapshot. It must not wait for a task
or open a subscription during SSR.

```ts
// src/routes/tasks/[taskId]/+page.server.ts
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params }) => {
  const task = await locals.supacloud.tasks.get(params.taskId);
  return { task };
};
```

If the application already exposes a business snapshot endpoint, call that
instead of composing several client requests. A task snapshot is not the same
as an authoritative business result; validate the business result through the
existing application command/receipt contract.

Do not call `wait()` or `subscribe()` in `load`, `+layout.server.ts` or a server
action. A task may run for minutes or hours. The browser owns live updates.

## Task submission: server action as transport

Use a server action to keep task names, bodies, tenant context and idempotency
keys out of the browser. The action should call the existing command boundary;
it should not duplicate business validation, audit or receipt state.

```ts
// src/routes/tasks/+page.server.ts
import { fail } from "@sveltejs/kit";
import type { Actions } from "./$types";

export const actions = {
  submit: async ({ locals, request }) => {
    const form = await request.formData();
    const caseId = String(form.get("caseId") ?? "");

    if (!caseId) return fail(400, { message: "caseId is required" });

    // Derive taskName/body from server-side context and validate access first.
    const task = await locals.supacloud.tasks.submit("aorist-ai/generate/crop", {
      body: { caseId },
      idempotencyKey: `crop:${caseId}:v1`,
    });

    return { taskId: task.taskId, status: task.status };
  },
};
```

If the existing application command gateway already produces the task receipt,
call that gateway here and return its receipt. Do not create a second
idempotency key store or a second audit path in SvelteKit.

An uncertain submission must remain uncertain. Map `writeMayHaveSucceeded` or
the application's `unknown` outcome to a confirmation/recovery UI; never retry a
write automatically under a new key.

## SPA task center

Task status, cancel, retry, dead-letter inspection and filtering are interactive
and long-lived. Keep that route client-rendered:

```ts
// src/routes/tasks/+page.ts
export const ssr = false;
```

Create the browser SupaCloud client once in browser application setup, using the
same public project configuration and the existing Supabase session. Do not reuse
the server `event.locals` client in the browser.

Subscribe or poll with an explicit cleanup function. Cleanup stops observation;
it does not cancel the server task and does not prove that a write rolled back.

## Command lifetime with `@supacloud/app-svelte`

`@supacloud/app-svelte` owns component and navigation lifetime only. It does not
provide authentication, a session store, a router or a SupaCloud host.

```svelte
<script lang="ts">
  import { beforeNavigate } from "$app/navigation";
  import { createSvelteCommandScope } from "@supacloud/app-svelte";

  const scope = createSvelteCommandScope({
    onNavigate: (invalidate) => beforeNavigate(() => invalidate()),
  });
</script>
```

Use the scope for an operation's attempt lifetime and late-result protection.
Persist unresolved operation identifiers in application-owned storage; do not
release a lock or delete an unknown operation just because the component
unmounted.

## Route policy

| Page | Recommended mode |
| --- | --- |
| Login and permission entry | SSR |
| Read-heavy detail or dashboard | SSR with request-scoped snapshot |
| Task submission form | SvelteKit server action |
| Task center and live status | SPA, `ssr = false` if needed |
| Rich editor and drag-heavy workspace | SPA |
| Zero-JS or legacy browser fallback | Separate Lite/SSR surface |

SvelteKit remains useful even when a route sets `ssr = false`: server actions,
cookies, request-scoped clients and deployment still apply. SSR is a per-route
choice, not an all-or-nothing migration.

## Verification checklist

- two concurrent requests never share a Supabase or SupaCloud client;
- a user session change cannot reuse another request's client;
- `load` performs no `wait()` or `subscribe()`;
- task submission is idempotent and records an uncertain outcome;
- browser cleanup stops observation without claiming server rollback;
- `ssr = false` routes still have a deliberate server action or API boundary;
- no service-role credential enters the browser bundle.