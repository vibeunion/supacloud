# Angular-inspired HTTP composition: supported semantics

This is the SupaCloud Promise-based outbound HTTP client, not Angular HttpClient
and not the SupaCloud platform SDK. Database, Auth, Storage and platform task
calls continue to use the existing `@supacloud/js`/Supabase clients. Do not wrap
SDK calls in another HTTP/auth/retry implementation.

## Parent delegation is real, explicit and scoped

`provideHttpClient(withRequestsMadeViaParent())` resolves the nearest parent
`HttpClient`. A missing parent fails when the provider is resolved, before any
network work. Child interceptors run first; parent interceptors run next; native
responses unwind back through the chains before the caller's requested decoding.
Multiple delegating injector levels are supported. The child borrows the parent;
destroying the child does not own or destroy that shared client.

Only local configuration and interceptors are resolved for a client configured
with `provideHttpClient`. Independent children no longer inherit ancestor
interceptors or transport implicitly. Use explicit parent delegation when that
composition is intended. Errors from configured provider factories propagate;
the provider path does not fall back to the standalone constructor's defaults.

`withFetch()` and `withRequestsMadeViaParent()` cannot be combined in the same
`provideHttpClient()` call, in either order. Duplicate transport features fail
instead of depending on last-writer-wins order. Repeated interceptor features
remain ordered and additive.

For new provider configuration use `withInterceptors` from `@supacloud/app/http`;
that entry shares the root client and tokens and returns an HTTP feature.
See [the public configuration recipe](./angular-enterprise-hardening.md#public-http-configuration).

The existing root `withInterceptors()` API returns an interceptor array, not a
provider feature. To configure through public root exports without changing that
legacy API, register the array with `HTTP_INTERCEPTORS`:

```ts
import {
  createEnvironmentInjector, HttpClient, HTTP_INTERCEPTORS,
  provideHttpClient, withFetch, withRequestsMadeViaParent, withInterceptors,
} from "@supacloud/app";

const parent = createEnvironmentInjector([
  provideHttpClient(withFetch()),
  {
    provide: HTTP_INTERCEPTORS,
    useValue: withInterceptors(async (request, next) => next(request)),
    multi: true,
  },
], undefined, { initialize: false });
const child = createEnvironmentInjector([
  provideHttpClient(withRequestsMadeViaParent()),
], parent, { initialize: false });
try {
  await parent.initialize();
  await child.initialize();
  const response = await child.get(HttpClient).get("https://example.test/health", {
    observe: "response",
  });
  console.log(response.status);
} finally {
  // Both scopes are explicitly owned by this composition root.
  try { await child.destroyAsync(); } finally { await parent.destroyAsync(); }
}
```

This example belongs in a trusted runtime composition root. Compiled business
modules retain constructor injection and generated factories; this change does
not add arbitrary runtime DI to the static application model.

## One logical request retains its replay policy

Parent delegation preserves the original caller signal, context and replay
policy. Replay guards follow the logical request to the final controlled fetch,
after all ancestor interceptors transform the request. A parent changing a GET
into a POST cannot obtain a fresh write budget each time a child retries.
Likewise, an interceptor cannot replace the caller's replay policy with its own.

Writes still default to one send. Explicit idempotent replay retains existing
body/key/header restrictions; it does not prove server idempotency, rollback,
or the outcome of an external operation. No automatic retries are added.
Interceptors that perform side effects outside the controlled transport remain
responsible for their own execution and ownership rules. HTTP timeouts and
workflow recovery are unchanged.

## Typed context defaults belong to one context

`HttpContext.get(token)` materializes a token's default once per context,
including `undefined`. Mutable default objects are stable across interceptors
and retries of that context. `has()` and `keys()` reflect the materialized value;
`delete()` allows a new default on the next read. Factories that throw propagate
the error without caching a value. Separate contexts do not share state.

Create a context per logical request. Context values are local coordination
metadata, not proof of identity, project membership or authorization.

## Verification

```sh
cd packages/app
bun run typecheck
bun run typecheck:test
bun test src/http_context_lifetime.test.ts src/http_parent_transport.test.ts src/http_parent_provider.test.ts
bun test
bun run build
```

The transport tests exercise real HttpClientCore and replay/contract modules
with synthetic HTTP responses. They are not live service or database tests.
Provider tests use the real SupaCloud/Angular runtime injector, not a replacement
container. Full package, public API and packed-consumer gates are still required.

Design references: Angular's public
[withRequestsMadeViaParent](https://angular.dev/api/common/http/withRequestsMadeViaParent)
and [HttpContext](https://angular.dev/api/common/http/HttpContext).
No Angular implementation source was copied.
