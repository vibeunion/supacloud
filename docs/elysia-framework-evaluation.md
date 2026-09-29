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
passes the repository's Elysia `2.0.0-beta.19` test and type gates.

### Local probe on 2026-09-29

The isolated probe used Bun `1.4.2` and Elysia `2.0.0-beta.19`:

- Native Elysia: bootstrap and `GET /probe` passed.
- Nestelia `1.11.2`: after installing its runtime validation dependencies,
  bootstrap failed while registering a route. It called Elysia 1.x's
  `.get(path, handler, hook)` order; Elysia 2 requires
  `.get(path, hook, handler)`. This is a confirmed incompatibility for the
  tested tuple.
- AponiaJS `0.6.0-alpha.37`: bootstrap failed because the platform imported
  `ElysiaCustomStatusResponse`, which is not exported by Elysia
  `2.0.0-beta.19`. This is a confirmed incompatibility for the tested tuple.

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
