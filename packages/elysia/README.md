# @supacloud/elysia

## Persistent Command Adapters

`createPersistentCommandAdapter(command, { identity, input })` binds a
`createTransactionalCommand` or `createExternalCommand` from `@supacloud/commands`
to `commandGovernance.rpc`.
Its capabilities distinguish `database` from `external` boundaries. It owns the
single write entry point and never invokes a second route handler or audit.
Resolve identity from a verified host context; all durable receipt reads and replays
must still pass domain authorization.

`createApplication({ normalize: false, ... })` rejects extra schema properties rather
than silently stripping them. Use shared schemas at domain and HTTP boundaries.

Alternatively, a meaningful Controller can call its injected Command directly,
with no route-level `command:` binding. `src/fixtures/webhook` follows this pattern.
`bun run generate:example` generates its factories; `src/webhook-migration-example.ts`
loads those artifacts for native HTTP/PostgreSQL acceptance. Tests reject stale
artifacts and cover writes, authorization, audit rollback and receipt recovery.
The runtime maps protocol errors without importing DB: explicit denial is 403,
authorization infrastructure failure is 503, and redacted-input lookup is 410.
See [the migration plan](../../docs/command-migration.md) for compiler policy,
authentication replay changes, deployment order and rollback limitations.

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
  HTTP 422 for request validation and HTTP 500 / `RESPONSE_VALIDATION_ERROR`
  for invalid handler output, without exposing payloads or schema internals.

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
validation response; invalid structured handler output returns HTTP 500 with
`RESPONSE_VALIDATION_ERROR`. A response validation failure can occur **after a
command has committed**; it does not imply rollback and must not trigger a blind
write retry. Confirm the outcome using the application's durable receipt or
read-back protocol. A custom `errorMapper` can override this public envelope.

Native `Response` objects are passed through by Elysia, including JSON responses.
Use `validatedJsonResponse` to opt into validation when constructing a native
JSON response. Otherwise handlers must validate their JSON payload themselves.
The adapter does not consume or parse binary/streaming responses.

Jobs are executed explicitly with `executeJob(compiledModule, services, job,
input, requestContext)`. The asynchronous compiler-generated job scope is
destroyed after execution, including when the job throws or scope construction
fails partway through.

## API

### External SupAuth Identity

`createSupAuthRequestContext(options)` supplies the trusted host adapter for an
external SupAuth user center. It uses `jose` signature verification, requires
configured HTTPS issuer/JWKS endpoints, audience, subject, expiry and issued-at,
and accepts only ES256/RS256. It does not implement login, sessions or token issuance.

```ts
import { createSupAuthRequestContext } from "@supacloud/elysia";

const requestContext = createSupAuthRequestContext({
  issuer: "https://identity.example/auth/v1",
  audience: "authenticated",
  clientId: "orders-oauth-client",
  projectId: "orders",
  jwksUrl: "https://identity.example/auth/v1/.well-known/jwks.json",
  resolveAccess: async (identity) =>
    accessRepository.findCurrentAccess(identity.issuer, identity.subject, "orders"),
});
```

`accessRepository` is application-owned and must return `{ projectId, tenantId,
permissions }` or `null` from authoritative local data. The factory rejects
missing/wrong-project access, ignores forwarded subject/tenant headers and
returns a frozen identity/access snapshot. Commands must still authorize current
object relationships within their durable transaction; a permission snapshot is
not an RLS replacement. The bearer credential is non-enumerable on identity.
Never log the complete request/context.

The adapter protects all routes using that context factory, including health
routes; mount intentionally public routes separately. Invalid credentials and
invalid signing keys fail closed with sanitized 401 responses. Tokens must have
`role: "authenticated"` and a matching `client_id` or `azp`; when both exist they
must match each other and the configured `clientId`. Verification service failures
return sanitized 503 `AUTHENTICATION_UNAVAILABLE`, never an identity fallback. Remote
JWKS uses bounded fetch timeout and the library's key cache; no token-provided key
URL or local identity fallback is accepted. `keyResolver` is a trusted host
override for pinned key sets/testing, never request input.

### Execution Inspection

Set `createApplication({ onExecution })` for metadata-only events: operation,
stage, kind, phase, elapsed time and a bounded request correlation ID. Module,
route and command aspects retain declared order. Standard governance exposes
authorization, idempotency, transaction, handler and successful audit stages.
Pass the final optional observer argument to `executeJob` for job traces.
No request input, token, result or error cause is sent to the observer.
The boundary and aspect index identify the static declaration; JavaScript
function names are display hints and may change when consumers minify a bundle.

Observer failures are isolated from business results; this is best-effort
telemetry, not durable audit. Use command governance for mandatory audit.
An inner successful stage does not prove the enclosing transaction committed.
The compiler's `context`/`explain` commands show the corresponding static plan.

Command transaction/idempotency continuations, custom route executors and job
handlers reject repeated invocation. This prevents accidental adapter retries
inside one invocation; cross-request/process deduplication still requires a
durable idempotency adapter.

### `validatedJsonResponse(validate, value, init?): Response`

Constructs a native JSON response after a synchronous, caller-owned type guard
validates the actual serialized JSON snapshot. The value type is inferred from
the guard; compatible extra fields are preserved. For a TypeBox contract, the
guard can delegate to `Value.Check(schema, value)` or a compiled validator.
No additional schema dependency is required by the adapter.

```ts
import { validatedJsonResponse } from "@supacloud/elysia";
import { isReportReceipt } from "./contracts";

return validatedJsonResponse(isReportReceipt, receipt, {
  status: 201,
  headers: { "x-request-id": requestId },
});
```

The helper serializes once, validates that wire snapshot, and sends those same
bytes. Validation cannot mutate the outgoing body; it is not a transform or
coercion hook. Guards must be synchronous and side-effect free. Serialization
failures and invalid receipts throw a sanitized `ApplicationError` with HTTP 500
and `RESPONSE_VALIDATION_ERROR`, without retaining payloads or validator causes.
The application's `errorMapper` can map this to its outcome-confirmation
protocol. The helper never retries a command or implies rollback.

`init` uses native `Response` options. The helper explicitly rejects null-body
statuses 204, 205 and 304, including on runtimes that otherwise accept a body
with those statuses. The default content type is
`application/json`, and explicitly supplied headers are preserved. This helper
is for bounded JSON payloads, not files or streams. Existing native `Response`
passthrough is unchanged.

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

### Shared Schema Decoders

`createSchemaDecoder(schema)` derives a decoder's output type from a TypeBox
schema, including transforms. Invalid values throw a sanitized
`SchemaContractError`. `defineJsonContract({ body, response }, request)` creates
decoders compatible with `HttpClient.execute` while retaining the same schemas
for route registration. Keep schemas independently importable and reference
their identifiers explicitly in compiler-analyzed route decorators.

See [command migration](../../docs/command-migration.md) for examples and
the distinction between contract declarations and runtime verification.
