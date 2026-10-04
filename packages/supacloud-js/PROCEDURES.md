# Generated Procedure Facade

The root `@supacloud/js` entrypoint provides a framework-neutral facade for
compiler-generated application clients:

```ts
import { createSupaCloudProcedureClient } from "@supacloud/js";
import { createApiClient } from "./generated/client";

const api = createSupaCloudProcedureClient({
  supabase,
  functionName: "app-api",
  generated: createApiClient,
});

await api.cases.detail.query({ params: { id: "case-1" } });
await api.cases.accept.mutate(
  { params: { id: "case-1" } },
  { idempotencyKey: "case-1-accept-v1" },
);
```

The facade creates no session, token store or second auth implementation.
`supabase-js` remains responsible for authentication, refresh, Functions,
Database, Storage and Realtime. The existing generated client transport and
callable route methods remain compatible, so migration can be incremental.

## Migration

Upgrade the compiler and SDK together and regenerate the application `client.ts`.
Existing `createApiClient({ fetch: createSupaCloudApiFetch(...) })` initialization
remains supported and retains the original error classes. Switch initialization
to the facade when ready; successful values, route decoder overloads and
`.query/.mutate` argument types are unchanged. Existing `api.cases.detail(input)`
calls also work through the facade. The facade normalizes failures from routes,
procedures and `api.request`; `buildRouteUrl` stays synchronous.

Facade `.mutate` calls with required idempotency must supply an execution key.
Direct generated procedures may still satisfy the legacy runtime check with an
explicit `idempotency-key` request header. Legacy callable routes retain their old
header and argument conventions. Extra generated-client settings can still be applied with
`generated: config => createApiClient({ ...config, normalize: false })`.
Do not override `config.fetch` or introduce retrying interceptors in that factory.

The same procedures work with the optional
[`@supacloud/js/query`](./QUERY.md) adapter and ordinary Svelte/React Query bindings.
The facade does not create a cache or import a framework runtime.

## Errors

`SupaCloudProcedureError` exposes:

- `code`: generated API or SupaCloud transport classification
- `status`: HTTP status, or `null` when no response was received
- `requestId`: bounded `x-request-id` (or the JSON body's `requestId`), or `null`
- `details`: the full JSON error body when available, including any domain `code`
- `response`: the original HTTP `Response` when available
- `cause`: the original Supabase `FunctionsHttpError`, fetch error or client error

```ts
import { FunctionsHttpError } from "@supabase/supabase-js";
import { SupaCloudProcedureError } from "@supacloud/js";

try {
  await api.cases.detail.query({ params: { id: "case-1" } });
} catch (error) {
  if (!(error instanceof SupaCloudProcedureError)) throw error;
  console.error(error.code, error.status, error.requestId);
  if (error.cause instanceof FunctionsHttpError) {
    // Identical to error.response; its body has not been consumed by the facade.
    const body: unknown = await error.cause.context.json();
  }
}
```

HTTP failures use `API_HTTP_ERROR`; JSON/schema failures use
`API_RESPONSE_INVALID` and undeclared success statuses use
`API_RESPONSE_UNDECLARED`. Network and relay failures use
`SUPACLOUD_TRANSPORT_ERROR` and `SUPACLOUD_FUNCTIONS_ERROR`; other client failures
use `SUPACLOUD_CLIENT_ERROR`. Invalid idempotency uses `SUPACLOUD_EXECUTION_ERROR`.
Native `AbortError` cancellation remains unchanged.

Error-body inspection reads only a clone of JSON failures, at most 64 KiB and
250 ms. Non-JSON, oversized, malformed or stalled bodies leave `details`
undefined without hiding the HTTP failure. Treat details as untrusted data.
`details`, `response` and `cause` are excluded from JSON serialization.
Successful response bodies may already be consumed when schema validation fails;
their status and headers remain available. If Supabase fails before returning a
response (including malformed success JSON), the original error is kept as
`cause`, but no HTTP status is fabricated.

## Mutation Safety

Mutations are never retried by this facade. Commands that declare required
idempotency reject before dispatch unless an invocation supplies a valid
`idempotencyKey`. Declared non-2xx response schemas retain the generated
client's typed-value behavior instead of being reclassified as exceptions.
Reuse the key only for the same logical operation. A failed or cancelled request
does not prove that a write rolled back; resolve uncertain outcomes before retrying.
The facade does not implement server-side idempotency or durable command receipts.
