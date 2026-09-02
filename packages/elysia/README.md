# @supacloud/elysia

Runtime adapter that turns `@supacloud/compiler` output into a production-ready
[Elysia](https://elysiajs.com/) application.

## Features

- **Decoupled compilation**: takes the output of `@supacloud/compiler` directly.
- **Topological initialization**: modules are registered in dependency order,
  passing exported services downstream via Elysia plugins.
- **Request-scoped providers**: creates a fresh scope per HTTP request via
  `createRequestScope`, mapping request-scoped controllers and services.
- **TypeBox schema binding**: attaches compiled parameter, query, body, and
  response TypeBox schemas directly to Elysia route definitions.
- **Unified Command Pipeline**: runs `@Command`-decorated handlers through a
  structured `commandGovernance` adapter chain or a custom `composeCommandExecutors`
  pipeline (fail-closed if command routes lack an executor).
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

## API

### `createApplication(options: ApplicationOptions): Elysia`

Creates the root Elysia application from compiled modules.

### `createModulePlugin(compiled, services, ctxFactory?, options?, imported?): Elysia`

Creates an Elysia plugin from a single compiled module. Can be mounted
directly onto an existing Elysia app.

### `composeCommandExecutors(...executors): CommandExecutor`

Composes multiple `CommandExecutor` middleware functions into an onion-style pipeline.

### `ApplicationError`

Lightweight error class carrying HTTP `status`, machine-readable `code`, and
optional structured `details`.
