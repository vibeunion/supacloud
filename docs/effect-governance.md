# Effect Governance

SupaCloud treats Effect as an execution contract for complex routes and
commands. Elysia remains the HTTP boundary, while the SupaCloud compiler owns
static application rules and generated route metadata.

SupaCloud currently pins Effect `4.0.2`. The adapter follows the Effect 4
execution model: the framework boundary receives an `Exit`, maps
`Cause.squash(exit.cause)`, and does not depend on the removed v3
`Runtime<R>` type or FiberFailure wrapper APIs.

```text
TypeBox/Elysia schemas -> HTTP boundary
SupaCloud Compiler      -> module, dependency, error and retry governance
Effect                  -> runtime execution, cancellation, timeout and retry
```

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
  },
});
```

All Effect governance checks default to `true`. `dependencies: []` and
`errors: []` are valid explicit declarations for an Effect that has no
environment or expected domain failures. Effect failures must be `never` or a
union of objects with a literal `_tag`; the tags must exactly match
`effect.errors`. The third `Effect` type parameter must exactly match
`effect.dependencies`, and a route with dependencies must declare a timeout.
Route handlers and production source cannot directly throw or interpret an
Effect with `Effect.run*`; test sources may interpret Effects for assertions.
The compiler recognizes both the subpath imports used by existing starters
(`effect/Effect`, `effect/Runtime`) and Effect 4 aggregate imports
(`import { Effect } from "effect"`).
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
  },
});
```

When enabled, an Effect route must declare its logical environment and public
failure mappings:

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

`dependencies` is checked against the declared Effect environment text. The
compiler does not attempt to reimplement Effect's runtime type system; it
ensures that the route's public declaration, generated descriptor and
application governance stay aligned.

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
- applies bounded retries only when `retry: "explicit"` and `maxAttempts` is
  present;
- maps tagged failures to public HTTP errors without exposing raw failure
  values;
- refuses explicit retry on a command that does not require idempotency.

Effect retry is not a substitute for command governance. An uncertain
non-idempotent write must use the existing receipt/read-back recovery protocol.
