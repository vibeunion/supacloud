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
