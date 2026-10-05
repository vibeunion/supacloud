# SupaCloud Elysia 2 Framework Evaluation

Date: 2026-09-29

## Decision

SupaCloud should provide an application framework experience on top of Elysia
2, but should not adopt NestJS, an Elysia-to-Nest adapter, or a second
Nest-like DI/runtime implementation.

The recommended product is:

```text
SupaCloud application kit
  -> @supacloud/app       modules, providers, scopes, controllers, commands
  -> @supacloud/compiler  static graph, contracts and generated factories
  -> @supacloud/elysia    Elysia 2 runtime adapter and governance
  -> Elysia 2 / Bun
```

The first implementation is `createSupaCloudFramework`. It is deliberately a
thin profile over `createApplication`, with strict input normalization disabled
by default, an explicit application name, native Elysia plugin support and the
existing compiled-module boundary.

## Candidate review

| Candidate | Current evidence | Decision |
| --- | --- | --- |
| NestJS plus an Elysia adapter | The adapter is pre-1.0 and declares Elysia 1.x | Excluded by request and by the Elysia 2 baseline |
| Nestelia 1.11.2 | Declares Elysia `^1.0.0`; no Elysia 2 compatibility claim | Do not adopt as a runtime dependency |
| AponiaJS 0.5.0 / 0.6 alpha | The platform package declares Elysia `^1.4.29`; alpha APIs and singleton-only providers | Reference ideas only |
| AdonisJS | Its HTTP context and lifecycle are integrated into its own runtime | Do not transplant onto Elysia |
| Native Elysia plugins and TypeBox | Native Elysia 2 path; keeps the platform boundary small | Use directly |

These checks are compatibility signals, not a claim that an Elysia 1 package
cannot run on a beta release. A package is not an approved dependency until it
passes the repository's Elysia `2.0.0-beta.21` test and type gates.

### Local probe on 2026-09-29

The isolated probe used Bun `1.4.2` and Elysia `2.0.0-beta.21`:

- Native Elysia: bootstrap and `GET /probe` passed.
- Nestelia `1.11.2`: after installing its runtime validation dependencies,
  bootstrap failed while registering a route. It called Elysia 1.x's
  `.get(path, handler, hook)` order; Elysia 2 requires
  `.get(path, hook, handler)`. This is a confirmed incompatibility for the
  tested tuple.
- AponiaJS `0.6.0-alpha.37`: bootstrap failed because the platform imported
  `ElysiaCustomStatusResponse`, which is not exported by Elysia
  `2.0.0-beta.21`. This is a confirmed incompatibility for the tested tuple.

The repository prototype test for `createSupaCloudFramework` passed. The full
package typecheck was not used as acceptance evidence because this checkout's
generated local dependency declarations were not built consistently; the
existing package typecheck must be run after the normal workspace build gate.

## Ideas worth adopting from AponiaJS

- One application bootstrap and one generated module graph.
- Clear startup diagnostics for missing, duplicate and ambiguous providers.
- A generator that creates a complete feature slice instead of isolated files.
- A versioned template and packed-consumer acceptance test.
- Optional development diagnostics that expose routes and providers without
  recording request bodies or credentials.

## Boundaries we will not copy

- No second DI container or second scope model.
- No `beforeHandle`/`afterHandle` pair presented as a transaction-safe
  around interceptor.
- No runtime fallback from stale generated artifacts in production.
- No automatic retry around commands with external side effects.
- No replacement of native Elysia route/plugin APIs with a proprietary DSL.

## Implementation roadmap

1. Keep `createApplication` as the low-level adapter and use
   `createSupaCloudFramework` as the product-level bootstrap.
2. Make the CLI starter the canonical developer experience: app creation,
   feature/resource generation, compile, inspect, check, build and dev.
3. Add a framework acceptance fixture covering module imports, application and
   request scopes, route contracts, native plugins, error mapping and command
   governance.
4. Add optional read-only graph and route diagnostics; redact headers, bodies
   and tokens by default.
5. Only consider an external framework if it can replace an existing boundary
   wholesale and declares or passes Elysia 2 compatibility.

## Acceptance boundary

The prototype is successful when a new application can:

- create a root module and feature module through the CLI;
- compile without runtime reflection;
- mount native Elysia plugins without losing type inference;
- enforce strict request contracts;
- isolate request-scoped providers;
- route writes through command governance;
- run the same business module through HTTP and a worker.

It is not yet a complete AdonisJS replacement. Database adapters, auth,
background jobs, documentation and deployment remain SupaCloud integrations,
not responsibilities of the bootstrap helper.

## Elysia 2 AOT evaluation & SupaCloud compiler alignment

Elysia 2 introduces build-time Ahead-Of-Time (AOT) compilation by shifting route
handler and schema compilation from server startup to build time via
plugins (e.g. `elysia/plugin/aot` across Bun, Vite, webpack, unplugin).

### Relationship with SupaCloud Compiler

SupaCloud Compiler and Elysia AOT operate at distinct abstraction layers:
- **SupaCloud Compiler (Macro / Domain layer)**: responsible for module graph
  resolution, permission guard injection, schema contract validation, and
  producing pure declarative router code.
- **Elysia AOT (Micro / Transport layer)**: responsible for dry-running the
  generated router skeleton, inlining TypeBox validations, pre-generating HTTP
  handler execution code, and producing a static route manifest bundle.

They are strictly complementary. SupaCloud does not duplicate HTTP route JIT/AOT
optimizations, and Elysia AOT does not handle multi-tenant domain boundaries.

### Critical constraint: Build-time side-effect isolation

Because Elysia AOT executes a dry-run import of the application instance at build
time to extract routes:
1. **Zero top-level I/O**: Bootstrapping routes must never trigger top-level
   database connections, remote config pulls, message broker binds, or read
   production-only secrets during module evaluation.
2. **Factory-based instantiation**: Router definition (`createRouter()`) must be
   separated from runtime initialization (`app.listen()`).
3. **Static route determination**: All routes and plugins exposed to AOT must be
   statically deterministic at build time; dynamic runtime-only routes must
   remain explicitly isolated.

## End-to-End Type Safety, Eden Treaty, and svadmin / SDK Integration

A core design feature of Elysia is unifying runtime validation and static TypeScript
types through TypeBox (`t.Object`, etc.). Combined with Eden Treaty (`treaty<AppRouter>`),
frontend clients can derive fully typed API clients directly from server router
definitions with zero codegen.

In SupaCloud, this end-to-end type derivation is fully supported, structured across
three architectural boundaries to respect browser bundle limits, distributed idempotency,
and platform release decoupling.

### 1. Handler-Level Context & Type Inference

In Elysia route handlers, TypeBox schemas act as the single source of truth:
- `defineRouteContract` and `defineElysiaRoute` contextually bind `body`, `params`,
  `query`, `headers`, and `cookie` schemas to the handler function argument.
- Handlers automatically receive exact static TypeScript types (`ctx.body`, `ctx.query`,
  `ctx.params`) without requiring manually written DTO interfaces or runtime type assertion.
- Status code response maps (`responses: { 200: Schema, 409: ErrorSchema }`) enforce
  exact return types and guard against undeclared HTTP response payloads.

### 2. Boundary 1: svadmin / Web Console Integration (Eden Treaty Pattern)

For administrative consoles such as `svadmin` (`packages/web-console`):
- **Zero-codegen type derivation**: When consuming Elysia-native routes, svadmin can
  utilize `@elysiajs/eden` (`treaty<AppRouter>`) or `@svadmin/elysia` adapters to
  obtain path autocomplete, typed request payloads, and typed response status mapping.
- **Strict bundle boundary**: svadmin and browser bundles must only consume pure route
  declarations (`import type { AppRouter } from ...`) or contract definitions. Server
  runtime dependencies (Node/Bun runtime, database connections, cryptographic modules,
  and deployment secrets) must never be imported into browser code.

### 3. Boundary 2: Platform SDKs (@supacloud/js) & Business Command Contracts

For platform-level SDKs and authoritative operations (`@Command`):
- **Beyond plain REST**: Business commands enforce distributed idempotency
  (`idempotency-key` headers), JWT authentication through SupaCloud Edge Runtime, and
  authoritative two-phase confirmation (Submit + Read-only Lookup) rather than blind HTTP retries.
- **Contract Facade with Zero Codegen**: Through `defineJsonContract` in `@supacloud/elysia`
  and `@supacloud/contracts` (`createAuthoritativeCommandClient`), the SDK derives typed
  decoders and static payload types directly from TypeBox schemas:
  - Input types: `Parameters<typeof contract.input>[0]` (equivalent to `Static<typeof BodySchema>`)
  - Output types: `ReturnType<typeof contract.result>` (equivalent to `Static<typeof ResponseSchema>`)
  - Client callers enjoy full compile-time static type safety without running code generators,
    while isolating browser code from internal server execution details and avoiding tight
    version coupling between the platform SDK and server releases.

### 4. Boundary 3: Multi-Language SDKs

For non-TypeScript ecosystems (such as Go, Python, or Flutter):
- Direct TypeScript type derivation across language boundaries is technically impossible.
- TypeBox route schemas automatically populate OpenAPI specifications via Elysia's
  documentation integration (`createDocumentationPlugin`), serving as the standardized
  metadata source for OpenAPI-based code generators.


