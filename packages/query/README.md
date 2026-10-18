# @supacloud/query

Typed, grouped TanStack Query options for compiler-generated SupaCloud clients.
Requires a regenerated client exposing `procedureClient`. Existing REST methods,
`API_PROCEDURES`, and `client.procedures` metadata remain unchanged.

```ts
import { createQueryAdapter } from "@supacloud/query";
import { createSupaCloudProcedureClient } from "@supacloud/js";
import { createApiClient } from "./generated/client";

const client = createSupaCloudProcedureClient({
  supabase,
  functionName: "application",
  generated: createApiClient,
});
const api = createQueryAdapter(client, {
  keyPrefix: [projectRef, tenantId, userId],
  queryClient,
});
const detail = api.items.detail.queryOptions(
  { params: { id: "item-1" } },
  { tags: ["items"] },
);
const mutation = api.items.accept.mutationOptions({
  invalidateTags: ["items"],
});
await mutation.mutationFn({
  input: { params: { id: "item-1" } },
  execution: { idempotencyKey: "attempt-1" },
});
```

Generated clients can carry explicit route and Feature Slice cache metadata.
When present, query options use the generated route `tags` by default and
mutation success uses the Feature transition `invalidateTags` by default.
Passing `tags` or `invalidateTags` remains an explicit per-call override; no
tags are inferred from controller or procedure names.

Inputs retain explicit `params`, `query`, `body`, `headers`, and `cookie`
sections. Required parameters and idempotency keys are checked by TypeScript.
No flat-input guessing, Supabase private-field inspection, or automatic mutation
retry is performed. Supabase auth/refresh and Functions transport remain owned by
`createSupaCloudProcedureClient`.

Recreate the adapter when project, tenant, or actor changes. Query keys snapshot
JSON inputs; mutation keys never contain execution keys. Cancellation is propagated
without claiming that a cancelled write rolled back. Tags are explicit and adapter
invalidation is limited to its identity prefix. A custom success callback does not
disable configured invalidation.

The SDK also accepts `apiClient` in `createSupaCloudClient`, or
`sdk.withClient(client)`. Both preserve inferred procedure types and expose
`queryAdapter({ keyPrefix, queryClient })`.

## Imperative Reads With Domain Contracts

Use `fetchQueryResult` for loaders that need a Promise rather than a component
query subscription. It reuses the existing QueryClient; do not create a second
cache or maintain a separate shared-request consumer counter.

```ts
import { fetchQueryResult } from "@supacloud/query";

const item = await fetchQueryResult(
  queryClient,
  api.items.detail.queryOptions({ params: { id: "item-1" } }),
  {
    decode: decodeItem,
    signal,
    staleTime: 10_000,
  },
);
```

`decodeItem` is the application's existing synchronous or asynchronous runtime
decoder. Its return type determines `item`; the helper requires a decoder and
does not supply an unchecked result-type override.
Generated transport validation still runs before the raw result is cached.
The additional domain decoder runs for **every caller**, including cache hits.
Only raw transport results are shared: one caller's narrower contract failure
does not evict or poison another caller's valid data. Do not mutate the raw value
inside a decoder.

Cancelling one caller rejects only that caller. When the last native query
observer leaves, TanStack cancels the transport and ignores its late response.
Other mounted query observers retain ownership. Cancellable imperative callers
sharing a key should all use this helper: bare `QueryClient.fetchQuery` calls do
not register observers. No read retry is added, even when client defaults retry.
Domain decoder errors and transport errors retain their original identity;
query cancellation is reported as `AbortError`.

- `refresh: true` cancels the previous exact-key fetch, marks its cache stale,
  and fetches a new snapshot. Superseded callers receive cancellation, not a
  successful stale value. Other identities and keys are untouched.
- `cache: "none"` bypasses both cache reads and writes for passwords, signed
  download credentials or other sensitive results. Calls are not deduplicated.
- Pass a component/target lifetime signal to stop obsolete consumers. Cancellation
  does not revoke a result already returned or prove that a write rolled back.
  This helper accepts query options, not mutations.

This replaces generic read execution glue, not application authorization,
business schemas, command receipts, task polling or the FA repository itself.

### Acceptance

```gherkin
Scenario: A cache hit cannot bypass a caller's contract
  Given one shared raw response and two different domain decoders
  When both callers read the same query
  Then each decoder runs and only the incompatible caller fails

Scenario: Cancellation belongs to a consumer
  Given two consumers share a pending query
  When one consumer cancels
  Then the other can finish and the cancelled consumer does not decode

Scenario: Refresh supersedes an old response
  Given a pending query that ignores cancellation
  When another caller explicitly refreshes and receives a new response
  Then the old response cannot replace the refreshed cache

Scenario: Sensitive reads bypass the cache
  Given a cached response for the same key
  When a caller selects cache none
  Then it reads the transport and does not change the shared cache
```
