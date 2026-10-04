# TanStack Query Adapter

`@supacloud/js/query` adds framework-neutral options for compiler-generated
`.query` and `.mutate` procedures. Use the host's existing TanStack binding and
QueryClient; this entrypoint creates neither a cache nor an authentication store.
No Svelte-specific SDK entrypoint is needed.

## Installation And Migration

```sh
npm install @supacloud/js @supabase/supabase-js @tanstack/query-core
# Svelte applications also use their normal framework binding:
npm install @tanstack/svelte-query svelte
```

The adapter targets Query Core `^5.104.1`; the integration tests use Svelte Query
`6.3.1`. Query Core is an optional peer. The root SDK does not import this adapter,
and the adapter has no runtime dependency on Supabase, Svelte or Query Core.

Regenerate `client.ts` with a compiler that emits `__supacloudProcedure` metadata.
Earlier generated clients remain usable directly, but cannot use these options
until regenerated. Existing route calls, response validation, interceptors,
`.query()` and `.mutate()` argument conventions are unchanged.

```ts
import { createSupaCloudApiFetch } from "@supacloud/js";
import { createSupaCloudQueryAdapter } from "@supacloud/js/query";
import { createApiClient } from "./generated/client";

// Reuse the application's existing user-scoped Supabase client.
const api = createApiClient({
  fetch: createSupaCloudApiFetch({ supabase, functionName: "app-api" }),
});
const queries = createSupaCloudQueryAdapter({
  keyPrefix: [projectUrl, "app-api", tenantId, actorId],
});
```

The Supabase client still owns session storage, refresh, auth headers, Database,
Storage, Realtime and Functions. No second token store or fetch/auth protocol is
introduced. This adapter works with other generated-client transports as well.

## Query Options

```ts
const input = { params: { id: "item-1" } };
const options = queries.queryOptions(api.items.detail.query, input, {
  staleTime: 30_000,
});

// Works with QueryClient and the host's framework query hook.
const item = await queryClient.fetchQuery(options);
const cached = queryClient.getQueryData(options.queryKey);

// One exact input, or every input for this procedure in the same identity scope.
await queryClient.invalidateQueries({ queryKey: queries.queryKey(api.items.detail.query, input), exact: true });
await queryClient.invalidateQueries({ queryKey: queries.queryKey(api.items.detail.query) });
```

Keys include the explicit namespace, query/mutation kind, HTTP method, route
template, and query input. Query inputs are immutable JSON snapshots: mutating an
input after building options cannot change the request under an old key. Cycles,
binary objects, functions and non-finite numbers are rejected for cached queries.
Pass `undefined` for a query with no required input. `select`, `enabled`, staleness
and other observer options remain TanStack options. Keys and request functions
are adapter-owned.

Query cancellation forwards TanStack's signal into the generated client.
No-content query results are normalized from `undefined` to `null`, because
TanStack cannot cache `undefined`; direct procedure and mutation results remain
unchanged. HTTP/validation errors retain the generated client's error metadata.
Schema-declared non-2xx responses retain the generated client's typed-data
semantics; this adapter does not reclassify them as exceptions.

The namespace is mandatory and must include all non-secret identities that
affect authorization and the target application/function. Recreate the adapter
on project, tenant or actor changes. Cancel/remove old scoped queries on logout;
do not preserve previous data across authorization boundaries. Use one QueryClient
per SSR request. Do not put tokens or session cookies in keys, request input,
metadata or persisted caches; use the existing Supabase session for auth.

## Svelte

Call the normal Svelte Query hooks inside a component under its existing
`QueryClientProvider`. Build options in their reactive accessors:

```svelte
<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { createSupaCloudQueryAdapter } from "@supacloud/js/query";
  import { createSvelteCommandScope } from "@supacloud/app-svelte";
  import { toStore } from "svelte/store";
  import { api } from "./api";

  let { projectUrl, tenantId, actorId, itemId } = $props<{
    projectUrl: string; tenantId: string; actorId: string; itemId: string;
  }>();
  const queryClient = useQueryClient();
  const queries = $derived(createSupaCloudQueryAdapter({
    keyPrefix: [projectUrl, "app-api", tenantId, actorId],
  }));
  const scope = createSvelteCommandScope({
    target: toStore(() => JSON.stringify([projectUrl, tenantId, actorId, itemId])),
  });

  const detail = createQuery(() => queries.queryOptions(
    api.items.detail.query, { params: { id: itemId } },
  ));
  const save = createMutation(() => queries.mutationOptions(api.items.save.mutate));

  async function submit(name: string, operationId: string) {
    const capturedQueries = queries;
    const input = { params: { id: itemId }, body: { name } };
    const attempt = scope.begin(operationId);
    try {
      await save.mutateAsync({
        input,
        execution: { idempotencyKey: operationId, signal: attempt.signal },
      });
      if (attempt.isCurrent()) {
        await queryClient.invalidateQueries({
          queryKey: capturedQueries.queryKey(api.items.detail.query, { params: input.params }),
        });
      }
    } catch (error) {
      if (attempt.isCurrent()) throw error;
    }
  }
</script>
```

`detail.data`, `detail.isPending`, `detail.error` and `save.mutateAsync` are typed
by the generated schemas. React and other bindings consume the same ordinary
options through their own query/mutation hooks; no framework runtime is imported
by this adapter. The focused tests cover Query Core runtime behavior and Svelte
type integration, not a browser-rendered application.

## Mutation Safety

Each invocation supplies `{ input, execution }`. A required command idempotency
key is required both by TypeScript and at runtime. It belongs to the logical
operation, not to the component or mutation-options factory. Reuse it only when
reconciling/retrying the same operation, never for a different write.

Mutations set `retry: false`, including when QueryClient defaults enable retry.
An unknown outcome is not permission to retry; first resolve the server outcome.
If the procedure has no required input or execution settings, use
`mutation.mutateAsync({})`. Mutation inputs are passed through, including binary
or multipart bodies supported by the generated client.

Capture `scope.begin(operationId).signal` when the user starts an operation and
pass it in `execution`. The existing `@supacloud/app-svelte` scope invalidates it
on target/navigation changes and destruction. An already-aborted signal prevents
dispatch; aborting in-flight work rejects waiting and ignores late completion.
This never proves a server write rolled back and never releases persistent locks.
Use `attempt.isCurrent()`/`attempt.commit()` for component effects and guard custom
error/settled callbacks, including callbacks already running at cancellation time.
TanStack's native mutation `scope` still means serial scheduling, not component
lifetime.

This first adapter does not add batching, subscriptions, infinite-query builders,
automatic mutation-to-query dependency inference or a new durable-command engine.
Invalidation and optimistic updates remain explicit TanStack behavior.
