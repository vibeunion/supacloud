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
The facade checks the generated `__supacloudClient.hooksVersion` capability and
rejects older generated files with a regeneration message. It returns the
generated client itself, without a Proxy.
Existing `createApiClient({ fetch: createSupaCloudApiFetch(...) })` initialization
remains supported and retains the original error classes. Switch initialization
to the facade when ready; successful values, route decoder overloads and
`.query/.mutate` argument types are unchanged. Existing `api.cases.detail(input)`
calls also work through the facade. The facade normalizes failures from routes,
procedures and `api.request`; `buildRouteUrl` stays synchronous.

All `.mutate` calls with required idempotency must supply an execution key,
including direct generated procedures. An `idempotency-key` request header
cannot satisfy this requirement. Legacy callable routes retain their old
header and argument conventions. Extra settings are inferred from the generated
factory's own configuration:

```ts
const api = createSupaCloudProcedureClient({
  supabase,
  functionName: "app-api",
  generated: createApiClient,
  generatedConfig: {
    normalize: false,
    headers: () => ({ "x-tenant": tenantId }),
    interceptors: [businessInterceptor],
  },
});
```

`fetch`, `errorMapper` and `procedureExecutionValidator` remain facade-owned,
including when configuration is supplied as an existing variable. Other
generated settings keep their original types and behavior. Custom factory
wrappers must forward these hooks; do not replace them or introduce retrying
interceptors. Supabase still owns authentication headers.

The same procedures work with the optional
[`@supacloud/js/query`](./QUERY.md) adapter and ordinary Svelte/React Query bindings.
The facade does not create a cache or import a framework runtime.

## Errors

`SupaCloudProcedureError` exposes:

- `code`: the closed `SupaCloudProcedureErrorCode` classification
- `status`: HTTP status, or `null` when no response was received
- `requestId`: bounded `x-request-id` (or the JSON body's `requestId`), or `null`
- `upstreamCode`: bounded domain/server code (or an unknown future generated code), or `null`
- `details`: the full JSON error body when available, including any domain `code`
- `response`: the original HTTP `Response` when available
- `cause`: the original Supabase `FunctionsHttpError`, fetch error or client error

```ts
import { FunctionsHttpError } from "@supabase/supabase-js";
import { isSupaCloudProcedureError } from "@supacloud/js";

try {
  await api.cases.detail.query({ params: { id: "case-1" } });
} catch (error) {
  if (!isSupaCloudProcedureError(error)) throw error;
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
`SUPACLOUD_TRANSPORT_ERROR` and `SUPACLOUD_FUNCTIONS_ERROR`. Unknown future generated
error codes use `SUPACLOUD_CLIENT_ERROR` with the original code in `upstreamCode`.
Invalid idempotency uses `SUPACLOUD_EXECUTION_ERROR`.
Unknown application, header-provider, interceptor and custom-decoder exceptions
remain unchanged, including `SyntaxError` and `TypeError`. Native `AbortError`
cancellation remains unchanged.

Use `isSupaCloudProcedureError` when catching errors across separately bundled
SDK entrypoints: their constructors need not have the same identity. This guard
checks the error's shape and known code, not its provenance; it is not an
authorization check or an error deserializer. Cross-realm errors are not
supported. `isSupaCloudProcedureHttpError` additionally narrows to a numeric
status and a `Response` (including contract failures on 2xx responses);
`isSupaCloudProcedureTransportError` narrows to network/relay codes.

Error-body inspection reads only a clone of JSON failures, at most 64 KiB and
250 ms. Non-JSON, oversized, malformed or stalled bodies leave `details`
undefined without hiding the HTTP failure. Treat details as untrusted data.
`details`, `upstreamCode`, `response` and `cause` are excluded from JSON serialization.
Generated clients decode buffered responses from a clone when possible, including
successful responses that fail schema validation. If cloning is unavailable,
decoding falls back to the original body. Successful live streams are not cloned.
This preserves the response received by the generated client; Supabase may have
already decoded its own successful response before adapting it to Fetch.
If Supabase fails before returning a
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

The facade's generated execution hook and the Query adapter share the same
validator. Standalone generated procedures enforce the same execution rules with
native `TypeError` failures, without adding an SDK runtime dependency. An
`idempotency-key` in request input, global headers or interceptors never replaces
the execution key. The captured execution key wins over header overrides.
Existing header-only procedure calls must move the key to the execution argument
when regenerating; callable route methods retain their original conventions.
