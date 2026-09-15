# @supacloud/app

Angular-style application metadata for SupaCloud applications: modules, DI
tokens, providers, scopes, controllers and commands.

This package is **metadata only**. Decorators attach metadata to classes; the
SupaCloud compiler (`@supacloud/compiler`) reads that metadata from source,
validates the dependency graph and generates plain static factories — there is
no runtime reflection and no `reflect-metadata` dependency.

## Zero-configuration start

For a complete runnable project, use `supacloud-cli app init --root ./orders --name orders`,
then `bun install`, `bun run check` and `bun run dev` inside `orders`.
The template includes compiler, Elysia, environment isolation and governance tests
without combining the three packages into a runtime dependency.

The smallest application can contain only a controller:

```ts
import { Controller, Get } from "@supacloud/app";

@Controller("/health")
export class HealthController {
  @Get("/ping")
  ping() {
    return { ok: true };
  }
}
```

Run `bunx supacloud-compiler compile` from the project root. The compiler
discovers the controller under `src/`, writes artifacts to `generated/`, and
enables strict checks by default. A module, provider, database client, or
command governance configuration is only needed when the application uses
that capability.

`defineFeatureSpec` preserves literal state/event types and rejects transition
endpoints outside `states` at type-check time. `FeatureState<typeof spec>` and
`FeatureEvent<typeof spec>` expose those unions to application code. Runtime
assertions and authoritative database checks are still required for external input.

Runtime DI delegates to Angular's public `@angular/core` APIs through a small
compatibility adapter. SupaCloud decorators retain module/compiler metadata,
while production application factories remain compiler-generated and
reflection-free.

## Runtime Boundary

Angular is the runtime DI engine: `InjectionToken`, hierarchical injectors,
`inject()`, `DestroyRef`, provider caching and lifecycle execution are delegated
to Angular public APIs. SupaCloud does not reimplement those mechanisms.

SupaCloud still owns the application model that Angular does not define:
`Module`, `Scope`, provider descriptors, controllers, commands, jobs, route
metadata, static aspects, `ApplicationGraph` and compiler diagnostics. Use
SupaCloud decorators for these semantics; they are compiler input, not Angular
decorator aliases.

## Static AOP

Use one `around(context, next)` function for cross-cutting behavior at the
module, route, command, or job boundary:

```ts
import type { Aspect } from "@supacloud/app";

const auditAspect: Aspect = async (context, next) => {
  const result = await next();
  await audit.write(context, result);
  return result;
};

@Module({ name: "case", aspects: [auditAspect] })
export class CaseModule {}
```

Aspect references must be explicit function identifiers. The compiler rejects
variables, spread expressions, strings, dynamic pointcuts, Proxy, and runtime
aspect registration. Angular remains the DI runtime; aspects are SupaCloud
compiler metadata and generated execution order.

```ts
import {
  Command,
  Controller,
  Inject,
  Injectable,
  InjectionToken,
  Module,
  Post,
} from "@supacloud/app";

export const CASE_REPOSITORY = new InjectionToken<CaseRepository>("case.repository");

@Injectable()
export class CaseService {
  constructor(
    @Inject(CASE_REPOSITORY) private readonly repository: CaseRepository,
  ) {}
}

@Command({ name: "case.accept", permission: "case.accept", transaction: "required" })
export class AcceptCaseCommand {
  constructor(private readonly cases: CaseService) {}
}

@Controller("/cases")
export class CaseController {
  constructor(private readonly acceptCase: AcceptCaseCommand) {}

  @Post("/:caseId/accept", { body: CaseAcceptInput })
  accept() {
    return this.acceptCase.execute();
  }
}

@Module({
  name: "case",
  providers: [
    CaseService,
    { provide: CASE_REPOSITORY, useClass: DrizzleCaseRepository },
    AcceptCaseCommand,
  ],
  controllers: [CaseController],
  exports: [CaseService],
})
export class CaseModule {}
```

## Scopes

| Scope | Lifetime | May depend on |
|---|---|---|
| `application` (default) | whole function instance | `application` only |
| `request` | one HTTP request | `application`, `request` |
| `job` | one background task | `application`, `job` |

The compiler rejects scope violations (e.g. an `application` provider
depending on a `request` provider) at build time.

## Bun Runtime Contexts

Use `bootstrapBun` for the process lifetime and pass its root injector to
`@supacloud/elysia` when route handlers use `inject()`:

```ts
import { bootstrapBun, provideToken } from "@supacloud/app";
import { createApplication } from "@supacloud/elysia";

const APP_NAME = Symbol("app-name");
const runtime = await bootstrapBun({
  providers: [provideToken(APP_NAME, "cases")],
  serve: async (injector) => {
    const app = createApplication({ modules, injector });
    return Bun.serve({ fetch: app.fetch, port: 3000 });
  },
});

// runtime.stop() stops the Bun server, awaits async teardown, and is idempotent.
```

When a root injector is supplied, the Elysia adapter creates one child
Injector per request, provides `REQUEST_CONTEXT`, preserves the context across
`await`, and destroys the child after the handler completes. Request contexts
are isolated with Node's `AsyncLocalStorage`; the compiler-generated request
scope remains available for existing applications.

Use `runInTransactionContext(root, providers, work)` at the database transaction
boundary to shadow tokens such as `DB_CLIENT` with the transaction-bound client.
The database adapter owns commit, rollback, and connection closure; the DI
scope only exposes the already-open transaction to code running inside it.

## Built-in Tokens

- `DB_CLIENT` — Platform database / Drizzle client (`application` scope).
- `REQUEST_CONTEXT` — HTTP request context (`request` scope).
- `JOB_CONTEXT` — Background job execution context (`job` scope).

## Non-decorator usage

`defineModule(options)` produces the same metadata as `@Module(options)` and
can be used where decorators are not enabled.

## Feature Slices and State Machines

`defineFeatureSlice` is an explicit, colocated feature slice entrypoint. It compiles
into a standard `ApplicationGraph` module without bypassing provider, route, command,
or module-boundary governance rules:

```ts
import { defineFeatureSlice, defineFeatureSpec } from "@supacloud/app";

export const caseSpec = defineFeatureSpec({
  name: "case",
  states: ["draft", "accepted", "rejected"],
  transitions: {
    accept: {
      from: "draft",
      to: "accepted",
      permission: "case.accept",
      command: "AcceptCaseCommand",
    },
  },
});

export const CaseFeature = defineFeatureSlice({
  name: "case",
  tags: ["type:feature", "scope:case"],
  spec: caseSpec,
  providers: [AcceptCaseCommand],
  controllers: [CaseController],
});
```

The compiler validates that feature states, commands, permissions, and transactions
remain synchronized and detects architectural drift at build time.

## Validated HTTP Contracts

Browser applications should import the browser-safe HTTP surface from
`@supacloud/app/browser`. The root `@supacloud/app` entrypoint includes the
Bun/Node DI runtime and is intended for server applications.

```ts
import { HttpClient, HttpContractError, type HttpContract } from "@supacloud/app/browser";
```

`HttpClient.execute(contract, input, options?)` infers input and result types from
`HttpContract` decoders. Each decoder accepts `unknown` and must reject invalid
values. TypeBox or an application decoder can be used for validation.

```ts
import type { HttpContract } from "@supacloud/app";

const saveItem: HttpContract<{ name: string }, { id: string }> = {
  input: decodeItemInput,
  result: decodeItemReceipt,
  request: (input) => ({ method: "POST", url: "/items", body: input }),
};
const receipt = await http.execute(saveItem, { name: "Example" }, {
  headers: { "Idempotency-Key": requestId },
  signal: abortController.signal,
});
```

Input decoding happens before transport. JSON parsing and receipt decoding happen
after transport; invalid/empty successful responses reject with
`HttpContractError` (`boundary: "request" | "response"`), without decoder causes or
payloads. HTTP errors remain `HttpErrorResponse`. Contract execution does not
retry; existing interceptors still control transport and must not replay an
unknown-result write. Raw JSON methods return `unknown` and no longer accept
caller-supplied result generics. Text, Blob and full Response modes have precise
overloads; use `execute` to obtain a checked business result.

`FormControl<T>` values now include `null`, and optional injection includes
`undefined`. See [type safety and migration](../../docs/type-safety.md) for the
strict configurations, consumer checks and remaining coverage boundaries.

### Schema-first route contracts

Use `defineRouteContract` to keep request and response schemas together. The
same contract can be referenced by a route decorator, a handler type and the
generated client:

```ts
import { defineRouteContract, type RouteHandler } from "@supacloud/app";
import { Type } from "@sinclair/typebox";

export const ItemBody = Type.Object({ name: Type.String() });
export const ItemHeaders = Type.Object({ authorization: Type.String() });
export const ItemCookie = Type.Object({ session: Type.String() });
export const ItemCreated = Type.Object({ id: Type.String() });
export const ItemConflict = Type.Object({ conflict: Type.Boolean() });

const itemRoute = defineRouteContract({
  body: ItemBody,
  headers: ItemHeaders,
  cookie: ItemCookie,
  responses: {
    201: ItemCreated,
    409: ItemConflict,
  },
});

type CreateItemHandler = RouteHandler<typeof itemRoute>;
// @Post("/", itemRoute) is analyzed by the compiler as the same contract.
```

For functional handlers, `defineRouteHandler` makes the contract the only
generic source and contextually types the callback. `defineTypedRoute` keeps the
same handler and contract together for adapters that accept an object:

```ts
import { defineRouteHandler, defineTypedRoute } from "@supacloud/app";

const createItem = defineRouteHandler(itemRoute, ({ body, headers, cookie }) => ({
  id: `${headers.authorization}:${cookie.session}:${body.name}`,
}));

const binding = defineTypedRoute(itemRoute, createItem);
```

The class-method form remains explicit (`RouteHandler<typeof contract>` or
`RouteHandlerInput`/`RouteHandlerOutput`). TypeScript decorators do not change a
method's parameter type, so the compiler treats the decorator contract as the
runtime/documentation source while the handler annotation is the type-level
binding.

`headers`, `cookie` and `responses` are now first-class route fields. The
`@Cookie()` parameter decorator binds a decoded cookie value to a positional
handler argument. New code should use `responses: { 200: Schema }` (or the
actual status map) instead of the legacy single `response: Schema` field.
The compiler currently accepts `response` as a migration bridge, but it is not
part of the long-term contract and may be removed in the next breaking release.
See the [route contract migration guide](../../docs/route-contract-migration.md).

### Authoritative Command Confirmation

Use the independent `@supacloud/contracts` package for `createAuthoritativeCommandClient`.
`@supacloud/app/contracts` is now a thin migration re-export.
Use it when a successful write acknowledgement does not prove the intended
resource state. The existing `createContractCommandClient` entry remains
available for response-first confirmation.

```ts
import { createAuthoritativeCommandClient } from "@supacloud/contracts/client";
import {
  decodeUpdate,
  decodeAcknowledgement,
  decodeWebhookState,
} from "./webhook-contracts";
import { adminApi } from "./admin-api";

const updateWebhook = createAuthoritativeCommandClient({
  input: decodeUpdate,
  acknowledgement: decodeAcknowledgement,
  authority: decodeWebhookState,
  matches: (input, state) =>
    input.id === state.id && input.enabled === state.enabled,
}, {
  send: (input) => adminApi.updateWebhook(input),
  lookup: (input) => adminApi.getWebhook(input.id),
});

const outcome = await updateWebhook({ id: "webhook-1", enabled: true });
// Only outcome.status === "confirmed" supplies outcome.authority.
```

The input decoder accepts untrusted data and supplies the typed input to both
transport methods. Acknowledgement and authority decoders operate on their own
raw network results, never on each other's transformed values. The default
`confirmation: "lookup"` performs one write and at most one automatic lookup,
even after a valid acknowledgement. Failed lookups are not retried. Each
invocation has independent state.

The optional third argument `{ confirmation: "response" }` allows the raw
write response to confirm the operation, but only after it passes both the
acknowledgement and authority decoders and the domain matcher. An invalid or
mismatched response falls back to one lookup.

Outcomes are discriminated by `status`:

- `invalid`: input validation failed before any transport call.
- `denied`: `isDefinitiveWriteFailure` explicitly classified a send rejection.
- `confirmed`: validated authority matches the intended state.
- `unknown`: no matching authority was obtained; this never permits a retry.

`diagnostics` contains fixed stage/code pairs, without exception messages,
payloads, tokens or URLs. Acknowledgements are either `unavailable` or
`validated` with a typed value. Domain schemas still own redaction of returned
business data. No HTTP status, including 401/403/409, proves denial by default.
Decoder, matcher and lookup failures never enter write-denial classification.
The legacy client now applies its denial classifier only to send failures too.

This is state confirmation, not durable server receipts, transactional audit,
or cross-client exactly-once execution. The transport must itself prevent
hidden write replay. Domain version matching, page disposal, durable locks,
pagination completeness and manual recovery remain application responsibilities.
Installing `@supacloud/contracts` alone does not install Angular or the app package.
Use `@supacloud/app-svelte` for Svelte lifecycle binding. The app package itself
continues to install its declared Angular DI dependency.
See [the architecture and migration guide](../../docs/command-migration.md).

### HTTP Replay Safety

`HttpClient` now defaults writes (including PUT and DELETE) to one call to its
configured fetch transport. Its final send boundary blocks repeated interceptor
calls with `HttpReplayError` (`code: "HTTP_REPLAY_BLOCKED"`), including an
authentication interceptor's attempt to resend after a 401. Token acquisition
before the initial send is unchanged. Read authentication refresh remains
available; `replay: { mode: "never" }` disables repeat sends for reads too.

`createRetryInterceptor(maxRetries, delayMs)` retries only transient HTTP
408/429/500/502/503/504 responses or non-abort transport exceptions, and only
for GET/HEAD/OPTIONS by default. It does not refresh authentication or retry
401/403 responses. Cancellation stops retries and interrupts backoff. Existing
call sites that relied on retrying every method/status must adopt an explicit
policy rather than silently retaining that behavior.

Only opt in after the server implements durable, appropriately scoped
idempotency and rejects reuse of a key with different operation input:

```ts
await http.post("/commands/update", input, {
  replay: { mode: "idempotent", idempotencyKey: operationId },
});
```

The key is sent as `Idempotency-Key` and must contain 1-200 ASCII letters,
digits, dots, underscores, colons or hyphens. A header alone does not authorize
replay. Conflicting keys are rejected before sending. Opted-in requests require
an immutable body (serialized JSON/text, Blob or no body); FormData, streams,
URLSearchParams and binary views must not be blindly replayed. Subsequent sends
must retain the same method, URL, body, key and non-Authorization headers.
The server must still authorize every attempt and scope receipts to the actor
and tenant; a refreshed bearer token alone is not proof of the same identity.

Native fetch redirects are disabled for writes and requests with an explicit
replay policy, preventing a 307/308 from resending outside the interceptor
pipeline. Use the final API URL. These guards cannot govern retries hidden
inside a custom fetch implementation, a service worker, proxy or remote service.
An SSO client that internally resends requests must be adapted to expose token
acquisition separately and use a single-attempt transport. A blocked replay or
aborted request does not mean the server rolled back the first write.

The regression acceptance scenarios for this first migration stage are:

```gherkin
Scenario: Acknowledgement is not authority
  Given a write returns a valid acknowledgement
  When the required authority lookup fails
  Then the outcome is unknown and no second write or lookup is sent

Scenario: Post-commit authentication failure
  Given the server applies the write and then returns 401
  When an authentication interceptor tries to resend the default write
  Then the second send is blocked and a matching authority lookup can confirm the result

Scenario: Explicitly idempotent replay
  Given the server implements durable idempotency and the caller opts in with an operation key
  When a transient response triggers retry
  Then every send retains its key, target, payload and request preconditions

Scenario: Cancellation during backoff
  Given a read is waiting to retry
  When the caller aborts its signal
  Then backoff stops and no further request is sent
```

These tests include a local HTTP server counting actual requests and a browser
bundle dependency-graph check. They are not authenticated customer acceptance,
proof of lower production incident rates, or a completed module migration.
