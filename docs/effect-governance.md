# Effect Governance

SupaCloud treats Effect as an execution contract for complex routes and
commands. Elysia remains the HTTP boundary, while the SupaCloud compiler owns
static application rules and generated route metadata.

SupaCloud currently pins Effect `4.0.5`. The adapter follows the Effect 4
execution model: the framework boundary receives an `Exit`, maps
`Cause.squash(exit.cause)`, and does not depend on the removed v3
`Runtime<R>` type or FiberFailure wrapper APIs.

```text
Framework boundary      -> request entry and exit, auth, idempotency, audit, response protocol
Effect program          -> one execution: typed failure, timeout, cancellation, composition
Pure functions          -> validation, mapping and domain calculation; not Effect
Receipts and jobs       -> durable replay of writes whose outcome may be unknown
```

The framework adapter in `@supacloud/elysia` is the only production interpreter.
Application code returns an `Effect` program. `dependencies: []` and
`retry: "none"` are explicit contracts, not evidence that a retry policy is
active. In-process retry is opt-in per failure: `retry: "explicit"` retries
only mappings marked `retryable: true`. Those mappings must be 5xx and must
not be `outcomeUnknown` or `statusFromError`. A 4xx, an unmapped failure, a
defect, or a write whose result is unconfirmed is never repeated by the
adapter. Replaying that write belongs to the command receipt or job lease.

## Default Strict Checks

Effect governance is enabled by default for compiler configuration. A project
can make the policy explicit in `supacloud.config.ts`:

```ts
import { defineSupacloudConfig } from "@supacloud/compiler";

export default defineSupacloudConfig({
  effect: {
    requireRouteEffects: true,
    requireErrorMappings: true,
    requireDependencies: true,
    requireTaggedErrorTypes: true,
    requireExactDependencyTypes: true,
    requireTimeoutForDependencies: true,
    forbidDirectRuntimeExecution: true,
    forbidDirectThrows: true,
    requireRetryPolicy: true,
    defaultRetry: "none",
  },
});
```

The resolved configuration defaults to `requireRetryPolicy: true` and
`defaultRetry: "none"`. Every route that declares an Effect contract must
write `retry`. `retry: "none"` is the required default policy, not evidence
that a retry is running. `retry: "explicit"` remains a per-route opt-in that
also needs `maxAttempts` and a retryable 5xx allow-list.

When `requireRetryPolicy` is `false`, an omitted `retry` is materialized as
`"none"` in the analyzed graph. It never enables retry. A project-level
`defaultRetry` cannot be `"explicit"`; explicit retry belongs only on the
route.

All Effect governance checks default to `true`. `dependencies: []` and
`errors: []` are valid explicit declarations for an Effect that has no
environment or expected domain failures. Effect failures must be `never` or a
union of objects with a literal `_tag`; the tags must exactly match
`effect.errors`. The third `Effect` type parameter must exactly match
`effect.dependencies`, and a route with dependencies must declare a timeout.
Route handlers and production source cannot directly throw or interpret an
Effect with `Effect.run*`; test sources may interpret Effects for assertions.
The only production interpreter allowlisted by the workspace source gate is
`packages/elysia/src/effect.ts`, the framework adapter. New production calls to
`Effect.runPromise`, `Effect.runPromiseExit`, `Effect.runSync`, or
`Effect.runFork` fail the source regression gate.
The compiler recognizes both the subpath imports used by existing starters
(`effect/Effect`, `effect/Runtime`) and Effect 4 aggregate imports
(`import { Effect } from "effect"`).

## Simple CRUD routes

Effect is required for routes by the strict default, but a simple non-command
route may opt into Promise mode explicitly:

```ts
@Get("/:id", {
  params: OrderParams,
  responses: { 200: OrderResponse },
  effect: false,
})
read(id: string): Promise<OrderResponse> {
  return this.orders.read(id);
}
```

`effect: false` only removes the Effect interpreter and Effect failure mapping
from that route. TypeBox request/response contracts, module boundaries, DI,
authorization and ordinary adapter error handling still apply. It cannot be
used on a route that enters a durable Command or feature transition. Commands,
workers, external effects, multi-step orchestration and routes that need typed
failures, timeout or explicit retry continue to declare an Effect contract.

This keeps the default strict for public governed applications while avoiding an
`Effect.promise` wrapper around a single model read.

Explicit `false` values are the opt-out mechanism for a migration boundary:

```ts
export default defineSupacloudConfig({
  effect: {
    requireRouteEffects: false,
    requireErrorMappings: false,
    requireDependencies: false,
    requireTaggedErrorTypes: false,
    requireExactDependencyTypes: false,
    requireTimeoutForDependencies: false,
    forbidDirectRuntimeExecution: false,
    forbidDirectThrows: false,
    requireRetryPolicy: false,
    defaultRetry: "none",
  },
});
```

When enabled, an Effect route must declare its logical environment, public
failure mappings, and its retry policy:

```ts
type OrderNotFound = { readonly _tag: "OrderNotFound" };

@Get("/:id", {
  params: OrderParams,
  responses: { 200: OrderResponse },
  effect: {
    required: true,
    dependencies: ["OrderApi"],
    errors: [
      { tag: "OrderNotFound", status: 404, code: "ORDER_NOT_FOUND" },
    ],
    retry: "none",
    timeoutMs: 1000,
  },
})
getOrder(): Effect.Effect<Order, OrderNotFound, OrderApi> {
  return Effect.gen(function* () {
    const api = yield* OrderApi;
    return yield* api.getOrder();
  });
}
```

A mapping entry may also opt into values carried by the failure itself. This is
for families of codes that cannot be enumerated statically (for example one
service-role misconfiguration reported under several diagnostic codes):

```ts
errors: [{
  tag: "FA_SERVICE_ROLE_REQUIRED",
  status: 503,
  code: "FA_SERVICE_ROLE_REQUIRED",
  codeFromError: true,
  messageFromError: true,
  statusFromError: true,
}],
```

All three flags default to `false` and must be boolean literals, so the declared `code`, `message` and
`status` stay authoritative unless a route opts in. Instance values are bounded
(120 characters for `code`, 500 for `message`, and an integer from 400 to 599
for `status`), must be non-empty, and never replace the declared tag. Keep
`codeFromError` limited to families whose codes are already part of the public
API contract.

`dependencies` is checked against the declared Effect environment text. The
compiler does not attempt to reimplement Effect's runtime type system; it
ensures that the route's public declaration, generated descriptor and
application governance stay aligned.

`errors` and `dependencies` may also reference a module-level, imported `const`
initialized with an array literal (including `as const` and `satisfies`), so a
project can keep one reviewed error catalog instead of repeating it per route:

```ts
export const ORDER_DEPENDENCIES = ["OrderApi"] as const;
export const ORDER_ERRORS = [
  { tag: "OrderNotFound", status: 404, code: "ORDER_NOT_FOUND" },
] as const;
```

```ts
@Get("/:id", {
  params: OrderParams,
  responses: { 200: OrderResponse },
  effect: {
    required: true,
    dependencies: ORDER_DEPENDENCIES,
    errors: ORDER_ERRORS,
    retry: "none",
    timeoutMs: 1000,
  },
})
```

Resolution is static. Entries must still be literals (string literals for
`dependencies`, object literals with literal `tag`, `code` and `status` for
`errors`); computed values, spreads or runtime expressions remain errors.

## Runtime Adapter

Provide the environment once at the Elysia boundary:

```ts
import { createEffectRuntimeFromLayer } from "@supacloud/elysia";

const app = createApplication({
  modules,
  effectRuntime: createEffectRuntimeFromLayer(AppLive),
});
```

The adapter:

- executes only values recognized as Effect programs;
- rejects a non-Effect value when the route declares `required: true`;
- applies the declared timeout;
- applies bounded retries only when `retry: "explicit"`, `maxAttempts` is
  present, and the failure tag is on the `retryable: true` allow-list;
- does not retry 4xx mappings, `outcomeUnknown` mappings, unmapped failures
  or defects;
- maps tagged failures to public HTTP errors without exposing raw failure
  values;
- refuses explicit retry on a command that does not require idempotency.

Effect retry is not a substitute for command governance. An uncertain
non-idempotent write must use the existing receipt/read-back recovery protocol.
