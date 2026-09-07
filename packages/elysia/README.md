# @supacloud/elysia

Runtime adapter that turns `@supacloud/compiler` output into a production-ready
[Elysia](https://elysiajs.com/) application.

## Features

- **Decoupled compilation**: takes the output of `@supacloud/compiler` directly.
- **Topological initialization**: modules are registered in dependency order,
  passing exported services downstream via Elysia plugins.
- **Request-scoped providers**: creates a fresh scope per HTTP request via the
  asynchronous compiler-generated `createRequestScope`, mapping request-scoped
  controllers and services.
- **Request-scope teardown**: invokes the compiler-generated
  `destroyRequestScope` after the response, including when the handler fails.
- **TypeBox schema binding**: attaches compiled parameter, query, body, and
  response TypeBox schemas directly to Elysia route definitions.
- **Compiler invoker execution**: uses the compiler-emitted positional invoker
  after Elysia has decoded route input, while retaining the legacy input-object
  handler path for hand-written compiled fixtures.
- **Unified Command Pipeline**: runs `@Command`-decorated handlers through a
  structured `commandGovernance` adapter chain or a custom `composeCommandExecutors`
  pipeline (fail-closed if command routes lack an executor).
- **Static AOP pipeline**: executes compiler-emitted module, route, command, and
  job aspects with `composeAspects`; no runtime discovery or registration is
  performed.
- **Public error mapping**: transforms framework / application errors via
  `errorMapper` with standard `ApplicationError` envelope support, preserving
  Elysia's default behavior (422) for schema validation errors.

## Installation

```bash
bun add @supacloud/elysia elysia
```

## Usage

```ts
import { composeCommandExecutors, createApplication, requireIdempotencyKey } from "@supacloud/elysia";
import AuditModule from "./.generated/audit.module";
import CaseModule from "./.generated/case.module";

const app = createApplication({
  name: "case-service",
  modules: [AuditModule, CaseModule], // topological import order
  deps: { db: createDbClient() },     // platform deps, passed to createServices
  commandGovernance: {
    authorize: (invocation) => authorize(invocation.requestContext, invocation.command.permission),
    idempotency: (invocation, next) => idempotencyStore.run(requireIdempotencyKey(invocation), next),
    transaction: (invocation, next) => transactionManager.run(invocation, next),
    audit: {
      succeeded: (invocation, result) => auditLog.record(invocation, result),
      failed: (invocation, error) => auditLog.recordFailure(invocation, error),
    },
  },
  // Or custom onion-style command pipeline:
  // commandExecutor: composeCommandExecutors(outerMiddleware, innerMiddleware),
});

export default app;
```

For deterministic local verification, use the in-memory sandbox. It supplies
stable request identity, an isolated key-value database with optimistic
transaction rollback, and an in-memory object store without requiring
PostgreSQL, GoTrue, or S3:

```ts
import { createMemorySandbox } from "@supacloud/elysia";

const sandbox = createMemorySandbox({
  modules: [CaseModule],
  identity: { authenticated: true, subject: "test-user" },
  requestId: "test-request",
});

const response = await sandbox.request("/cases/42");
sandbox.db.set("cases", "42", { state: "draft" });
sandbox.storage.put("evidence", "42.txt", "fixture");
sandbox.reset();
```

Route `body`, `params`, `query`, and `response` schemas are enforced by
Elysia before and after the handler. Invalid input returns the standard `422`
validation response; invalid handler output is rejected before it reaches the
client.

Jobs are executed explicitly with `executeJob(compiledModule, services, job,
input, requestContext)`. The asynchronous compiler-generated job scope is
destroyed after execution, including when the job throws or scope construction
fails partway through.

## API

### `createApplication(options: ApplicationOptions): Elysia`

Creates the root Elysia application from compiled modules.

### `createModulePlugin(compiled, services, ctxFactory?, options?, imported?): Elysia`

Creates an Elysia plugin from a single compiled module. Can be mounted
directly onto an existing Elysia app.

### `composeCommandExecutors(...executors): CommandExecutor`

Composes multiple `CommandExecutor` middleware functions into an onion-style pipeline.

### `composeAspects(...aspects): ApplicationAspect`

Composes static `around(context, next)` functions. Calling `next()` more than
once is rejected.

### `executeJob(...)`

Executes a compiler-emitted Job descriptor with its static aspect list and
compiler-generated job scope.

### `assertFeatureTransition(spec, state, event)`

Checks a declared feature transition against an authoritative state and returns
the destination state. Unknown events, stale/illegal states and inherited object
members fail with HTTP 409 / `FEATURE_TRANSITION_CONFLICT`; malformed destinations
fail with `FEATURE_SPEC_INVALID`. The helper is a matrix assertion, not a workflow
engine, persistence or authorization layer. Call it inside the application's
transaction and persist with a row lock or expected-version check.

### `ApplicationError`

Lightweight error class carrying HTTP `status`, machine-readable `code`, and
optional structured `details`.

### `createMemorySandbox(options): MemorySandbox`

Creates an in-process application harness with `request()`, `db`, `storage`,
`identity`, `policy`, `audit`, and `reset()`. The memory database is a deterministic test adapter,
not a PostgreSQL emulator; its transaction callback operates on an isolated
snapshot and detects concurrent commits.

The adapter boundary is intentional: production authorization, RLS, PostgreSQL,
S3 visibility and failure semantics must be supplied by application governance
adapters. The memory harness is limited to deterministic HTTP, key-value
transaction and object-storage contract tests.
`policy` supplies explicit permission grants/revocations and idempotency claims;
`storage.failNext()` makes storage failure paths deterministic.

Set `memoryGovernance: true` to enable test-only authorization, transaction,
idempotency and audit adapters; permissions still require explicit grants.
HTTP receipt fingerprints include route, body, params, query and business
headers, not mutable request scopes/services or identity/tracing transport.
Authorization runs again on a replay. Use durable application-owned adapters
for production receipts, transactions and audits.
