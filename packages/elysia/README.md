# @supacloud/elysia

For a cross-module composition shared by HTTP, event/scheduled workers and a
trusted CLI, see the [fulfillment example](src/examples/fulfillment.ts) and
[developer guide](../../docs/framework-composition.md). It reuses bound commands,
explicit aspects and durable receipts, not a new workflow engine. Compensation
is a separately authorized business command, never an assumed rollback.

## Compatibility and Acceptance Boundary

The dependency range is not a claim that every allowed version has been tested.
The focused conformance suite was verified with Bun 1.4.2 and Elysia 1.4.30.
The package declares Elysia `^1.4.30` as a peer and TypeScript `^7.0.2` as a
development dependency. `compatibility.json` records the exact exercised tuple,
including the compiler's separate TypeScript 6 semantic API. The contract-upgrade
gate checks both that semantic API and the TypeScript 7 CLI. These tests do not
establish a wider version matrix or Node.js runtime compatibility.

Run `bun run test:conformance` in this package after building the local
`@supacloud/contracts` and `@supacloud/app` dependencies and installing this
package's dependencies. The suite runs through `app.handle(Request)` without a
network listener. It is included in the normal `bun test` discovery.

| Boundary | Acceptance evidence in `src/conformance.test.ts` |
| --- | --- |
| Decoded body, params, query, headers and cookies | Native/adapter response comparison, with explicit decoded-value assertions |
| Response normalization and declared status maps | Native/adapter comparison, including a 409 response |
| Native `Response` transport | Status, body, content type, custom header and outgoing cookie preserved |
| Parent lifecycle hooks | Request, before-handler, handler and after-handler order compared |
| Parent early return | 403 response compared; controller must not run |
| Local sibling hooks | Local hook cannot intercept compiled routes |
| Request schema failure | Native 422 status retained; controller must not run |
| Malformed JSON | Native 400 status retained for multiple malformed bodies; controller must not run |
| Error mapper precedence | Custom mapper handles parse failure before request context resolution |
| Module error isolation | Internal exception redacted; sibling native error handling remains unchanged |
| Invalid handler output | Intentional 500 response with `RESPONSE_VALIDATION_ERROR` |
| Unsupported route descriptors | Unsupported methods/native hooks rejected before registration |
| Duplicate protocol package copies | Known command errors retain their status; unknown codes remain internal |

### Intentional Adapter Semantics

- Default parse failures return HTTP 400 with `PARSE_ERROR`; request schema
  failures return HTTP 422 with `VALIDATION_ERROR`. Their public messages do not
  include parser details, submitted values or schema internals.
- Invalid handler output returns HTTP 500, not a client-input error. It may occur
  after business work has completed and must not be interpreted as a rollback.
- Unknown handler exceptions are redacted. Known `CommandError` instances are
  recognized by their Error identity, name and allowlisted code across separate
  protocol package copies, never by exposing their message. A configured `errorMapper` can
  override these defaults and owns the safety of its response.
- Cookie input passed to a compiled controller contains decoded values, not
  Elysia's mutable cookie wrappers. Native `Response` headers can carry outgoing
  cookies.
- Errors before context resolution have no request context. Error mappers must
  not assume identity or request-scoped services are available.

### Not Yet Proven by This Suite

WebSockets, streaming and disconnect behavior, multipart uploads, signed-cookie
mutation, arbitrary third-party plugins, alternate runtime/version combinations,
concurrent tenant isolation, database transaction/idempotency guarantees and
published-package installation are not covered by the conformance suite alone.
Runtime safety is covered separately below. This list records
an evidence gap, not a declaration that all these features are unsupported.
Do not claim complete Elysia compatibility from this gate.

Compiled routes accept only the HTTP methods and schema fields declared by
`CompiledRoute`, plus compiler-emitted parameter transformation/default and
descriptive metadata. This metadata does not install native Elysia hooks.
Other descriptor fields (including browser guards/resolvers and native
`beforeHandle`) or unsupported methods throw `ROUTE_DESCRIPTOR_UNSUPPORTED`
at registration. It is not an arbitrary Elysia route-options passthrough.
TypeScript/decorator inference, compiler migrations and generated client parity
require their own acceptance gates.

### Runtime and Upgrade Gates

`bun run test:runtime-safety` requires `SUPACLOUD_COMMAND_TEST_URL` and fails
instead of skipping when it is missing. Use a dedicated loopback database named
`supacloud_commands_test`, with PostgreSQL 18 and PGMQ 1.10.0; initialize it using
`scripts/prepare-command-test-database.ts`. The gate opens real loopback HTTP
listeners and exercises compiler-generated request-scoped controllers. It proves
overlapping tenant/actor requests, duplicate-key concurrency, authorization
revocation, audit rollback, same-key retry and per-request provider teardown.
Its authentication uses a fixed test token map, not a production JWT provider.

`bun run test:contract-upgrade` copies a fixed legacy source fixture, previews and
applies its versioned migration, compiles factories/client/OpenAPI, checks positive
and negative types with both TypeScript engines, and calls the generated client
over real HTTP. It restores the old source checkpoint, regenerates artifacts and
executes the restored application. Build local contracts, app and compiler
(including declarations) before installing this package's copied file dependencies.

These gates prove the stated scenarios, not a full historical npm upgrade matrix
or all business-domain isolation. See [framework acceptance](../../docs/framework-acceptance.md)
for the evidence boundaries and upgrade policy.

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

## Bind A Command Once

`bindCompiledCommand` is an optional convenience layer over
`executeCompiledCommand` and `previewCompiledCommand`. Register static wiring
once and supply fresh trusted host context for each invocation:

```ts
import { bindCompiledCommand } from "@supacloud/elysia";

const approve = bindCompiledCommand({
  module: generatedApprovalModule,
  command: "ApproveCommand", // compiled class name
  governance,
  handler: (input: ApproveInput, call) =>
    approvalService.execute(input, call.requestContext),
  decode: decodeApprovalResult,
  preview: (input, call) =>
    approvalService.preview(input, call.requestContext),
});

// In a trusted HTTP controller, Worker job, or server-side CLI adapter:
const result = await approve.execute(input, {
  request,
  requestContext: verifiedContext,
  services,
  scope,
});
```

The generated module, domain types, service, decoder and governance above are
supplied by the application. The wrapper does not implement a second business
model, permission system, transaction mechanism or identity provider.

- A binding does not execute business code or capture a request identity.
  Calls still resolve the descriptor and authorize each execution, including
  idempotent replays. Static dependencies should be application-scoped; resolve
  request/job-scoped services from the current `call.scope` instead of capturing
  them in the binding.
- `preview` is present only when a domain preview function was supplied.
  An explicit callback makes it callable without a presence check; dynamically
  optional configuration still requires checking `approve.preview`. It reuses the existing read-only
  preview API: authorization and domain preview only, no command execution,
  aspects, transaction, idempotency, RPC or audit.
- Keep decoding/validating untrusted input at the existing ingress/domain
  boundary. A TypeScript input type alone is not runtime validation.
- An HTTP handler calling `approve.execute` must not also bind that same
  command through route-level `command:` metadata. Choose one execution
  boundary to avoid duplicate authorization or aspect execution. Likewise,
  place command aspects on the business module, not a duplicate entry module.
- Workers must resolve trusted identity in the host and explicitly construct
  the call's `Request`, cancellation signal and idempotency context where
  applicable. Do not infer identity from queue payloads. The binding adds no
  retry, acknowledgement or scope-cleanup policy.
- The result decoder still runs after execution or receipt replay. A decoding
  failure does not prove rollback and must not trigger a blind retry.

Existing direct APIs, route bindings, custom executors, RPC adapters and Worker
transports remain available without adopting the binding. Local parity tests
cover HTTP and Worker ingress with fake governance adapters; real database
atomicity remains covered by the separate PostgreSQL acceptance gates.

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
- **Compile-time DI**: constructor dependencies are directly connected by generated
  factories. Request/job context is passed explicitly without runtime injector
  discovery, registration or token lookup.
- **TypeBox schema binding**: attaches compiled parameter, query, body, headers,
  cookie, single-response and status-map TypeBox schemas directly to Elysia
  route definitions; Elysia performs request validation and normalization.
- **Schema-first client decoding**: generated clients select the declared
  response schema by HTTP status and validate/normalize it before returning;
  an explicit decoder receives that checked value for custom transforms.
- **Compiler invoker execution**: uses the compiler-emitted positional invoker
  after Elysia has decoded route input, while retaining the legacy input-object
  handler path for hand-written compiled fixtures.
- **Unified Command Pipeline**: runs `@Command`-decorated handlers through a
  structured `commandGovernance` adapter chain or a custom `composeCommandExecutors`
  pipeline (fail-closed if command routes lack an executor).
- **Static AOP pipeline**: executes compiler-emitted module, route, command, and
  job aspects with `composeAspects`; no runtime discovery or registration is
  performed.
- **Worker registration**: registers compiler-emitted Jobs, initializes their
  application services once, and provides polling plus graceful shutdown around
  a host-owned claim/receipt transport.
- **Public error mapping**: transforms framework / application errors via
  `errorMapper` with standard `ApplicationError` envelope support, preserving
  HTTP 422 for request validation and HTTP 500 / `RESPONSE_VALIDATION_ERROR`
  for invalid handler output, without exposing payloads or schema internals.
- **Opt-in API documentation**: serves a generated OpenAPI JSON document and a
  dependency-free viewer, plus a role-scoped GraphQL SDL snapshot viewer.

## Installation

```bash
bun add @supacloud/elysia elysia
```

## Usage

```ts
import { composeCommandExecutors, createApplication, requireIdempotencyKey } from "@supacloud/elysia";
import AuditModule from "./.generated/audit.module";
import CaseModule from "./.generated/case.module";
import { OPENAPI_DOCUMENT } from "./generated/openapi";

const app = createApplication({
  name: "case-service",
  modules: [AuditModule, CaseModule], // topological import order
  deps: { db: createDbClient() },     // platform deps, passed to createServices
  documentation: {
    openApi: {
      document: OPENAPI_DOCUMENT,
      specPath: "/openapi.json",
      uiPath: "/docs",
    },
    graphql: {
      schema: () => Bun.file("./graphql/schema.graphql").text(),
      schemaPath: "/graphql/schema.graphql",
      uiPath: "/graphql/docs",
    },
  },
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

Documentation is disabled unless `documentation` is provided. The OpenAPI
document can be imported from the compiler-generated `openapi.ts` module. The
GraphQL endpoint serves a local, role-scoped snapshot only; it does not enable
server introspection or create a GraphQL resolver layer. Protect or omit these
routes in production when the schema is not public.

Use constructor injection and the generated `createServices`,
`createRequestScope` and `createJobScope` factories. Compiled applications reject
property `inject()` and runtime injection contexts with `SC2012`. The host provides
platform dependencies through `deps` and owns their lifecycle; generated factories
own application scope construction and teardown.

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

### Worker Registration

`createWorker` registers compiled modules and drives a host-provided claim,
acknowledge and fail transport. The worker owns Job lookup, application-service
initialization, concurrency and graceful shutdown. The platform adapter remains
the owner of leases, retries, DLQ policy and receipt semantics; its receipt type
is preserved as `TReceipt`. `createQueueWorkerTransport` adapts the structural
API of the existing `client.queue(name)` without making Elysia depend on the SDK.

```ts
import {
  createQueueWorkerTransport,
  createWorker,
  type WorkerClaim,
} from "@supacloud/elysia";
import type { SupaCloudQueueMutationResult } from "@supacloud/js";
import { createCompiledModules } from "./generated/application";

type QueueClaim = WorkerClaim & { queueMessageId: string };
type PlatformReceipt = SupaCloudQueueMutationResult;

// `supacloud` is a configured createSupaCloudClient(...) instance.

const transport = createQueueWorkerTransport({
  queue: supacloud.queue("jobs"),
  receive: { visibilityTimeoutSec: 60 },
  decodeClaim: (message): QueueClaim => {
    const payload = message.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Invalid job envelope");
    }
    const envelope = payload as Record<string, unknown>;
    if (typeof envelope.jobName !== "string" || !("input" in envelope)) {
      throw new Error("Invalid job envelope");
    }
    return {
      id: message.id,
      queueMessageId: message.id,
      jobName: envelope.jobName,
      input: envelope.input,
      attempt: message.read_ct ?? 1,
    };
  },
  messageId: (claim) => claim.queueMessageId,
});

const worker = createWorker<QueueClaim, PlatformReceipt>({
  modules: createCompiledModules(),
  deps: { supacloud },
  concurrency: 4,
  transport,
});

await worker.start();
// The host owns process signals and calls this during shutdown.
await worker.stop();
```

Use `mapClaim` when a platform claim has a different wire shape. Duplicate module
or Job names are rejected before registration is committed. A Job failure is
reported through `fail`; an unconfirmed `ack` is surfaced as
`WorkerReceiptUnconfirmedError` and is never followed by a blind `fail`. The
queue adapter preserves the queue client's mutation receipt type. With PGMQ,
the SDK's `fail` compatibility method archives the message; use a custom
transport when the platform needs a distinct retry or dead-letter transition.

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

For hand-written Elysia routes, `defineRouteContract` and
`defineElysiaRoute` provide contextual handler types from the same schema value.
`registerElysiaRoute` maps the contract's `responses` status map to Elysia's
`response` option and registers the route:

```ts
import { Elysia, t } from "elysia";
import {
  defineElysiaRoute,
  defineRouteContract,
  registerElysiaRoute,
} from "@supacloud/elysia";

const itemRoute = defineRouteContract({
  body: t.Object({ name: t.String() }),
  params: t.Object({ id: t.String() }),
  responses: {
    200: t.Object({ id: t.String(), name: t.String() }),
    409: t.Object({ conflict: t.Literal(true) }),
  },
});

const route = defineElysiaRoute("POST", "/items/:id", itemRoute, ({ body, params, status }) =>
  body.name === "existing"
    ? status(409, { conflict: true })
    : { id: params.id, name: body.name },
);

const app = registerElysiaRoute(new Elysia(), route);
```

The callback is typed from the contract (including decoded transforms and
declared response statuses). Cookie values retain Elysia's native shape, so a
declared `session: t.String()` is read as `cookie.session.value`. This helper
does not add Eden-style client inference to an existing Elysia instance; the
compiler-generated client remains the source of transport types.

Response maps may use concrete statuses, `1XX`-`5XX` families, and `default`.
Because Elysia 1.4 only compiles numeric response keys, the adapter expands
family/default entries to concrete validators before registration. Exact
statuses take precedence over families, which take precedence over `default`.
An actual status absent from a structured response map fails the route contract
before Elysia can silently accept a default `200`; binary/stream routes may
intentionally leave successful transport statuses unschematized when only their
JSON error responses are declared. Unsupported selectors fail during
registration instead of silently disabling response validation.

See [type safety and migration](../../docs/type-safety.md) and [command migration](../../docs/command-migration.md) for examples and
the distinction between contract declarations and runtime verification.
