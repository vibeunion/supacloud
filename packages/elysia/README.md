# @supacloud/elysia

Elysia runtime adapter for SupaCloud applications: it adapts the plain-data
`CompiledModule` produced by `@supacloud/compiler` into Elysia plugins and
manages the `application` / `request` scopes at runtime.

This package does **not** depend on the compiler. The contract below is
declared and re-exported locally; any object matching it works.

## Compiled module contract

```ts
interface CompiledRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  handler: string;   // method name on the controller instance
  body?: unknown;    // TypeBox schema; validation enabled only when present
  params?: unknown;
  query?: unknown;
  response?: unknown;
  command?: string;  // @Command class name bound to the route
}

interface CompiledCommand {
  className: string;
  name: string;
  permission?: string;
  transaction?: string;
  audit?: string;
  idempotency?: string;
}

interface CompiledController {
  path: string;                       // controller prefix, e.g. "/cases"
  serviceKey: string;                 // key on services or the request scope
  scope: "application" | "request" | "job";
  routes: CompiledRoute[];
}

interface CompiledModule {
  name: string;
  createServices(
    deps: Record<string, unknown>,
    imported: Record<string, Record<string, unknown>>,
  ): Record<string, unknown>;
  createRequestScope?(
    services: Record<string, unknown>,
    ctx: unknown,
    imported?: Record<string, Record<string, unknown>>,
  ): Record<string, unknown>;
  controllers: CompiledController[];
  commands?: CompiledCommand[];
}
```

Controller methods are invoked as
`controller[handler]({ body, params, query, request, scope })`; non-`Response`
return values are serialized to JSON by Elysia. Validation failures use
Elysia's default behavior (422).

## Usage

```ts
import { createApplication } from "@supacloud/elysia";
import AuditModule from "./.generated/audit.module";
import CaseModule from "./.generated/case.module";

const app = createApplication({
  name: "case-service",
  modules: [AuditModule, CaseModule], // topological import order
  deps: { db: createDbClient() },     // platform deps, passed to createServices
  requestContext: (request) => ({
    requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    request,
  }),
  commandExecutor: async (invocation, next) => {
    await authorize(invocation.requestContext, invocation.command.permission);
    return next();
  },
});

export default app;
```

- Each module is instantiated in order: `createServices(deps, imported)`
  receives platform `deps` plus the services of all previously created
  modules, keyed by module name.
- Each module becomes a named Elysia plugin (`supacloud:<module.name>`) that
  decorates the context with `services`.
- When a module defines `createRequestScope`, a **fresh** request scope is
  resolved per request and exposed on the `scope` context key — never reused
  across requests. Request-scoped controller instances are looked up on
  `scope`; application-scoped instances on `services`.
- Full route paths are `controller.path + route.path` (slashes normalized);
  schema options (`body` / `params` / `query` / `response`) are passed to
  Elysia only when the corresponding field exists.
- A route with `command` must pass through `commandExecutor`. Missing executors
  fail closed with `501 COMMAND_EXECUTOR_UNAVAILABLE`.
- `errorMapper` can map failures to an application-specific envelope. The
  default response is `{ ok: false, code, message, details? }`.

Lower-level building blocks:

- `createModulePlugin(compiled, services, ctxFactory?)` — adapt a single
  module into an Elysia plugin (useful for tests and embedding).
- `createTestApp(options)` — semantic alias of `createApplication`.
- `testRequest(app, path, init?)` (from `@supacloud/elysia` source
  `src/testing.ts`) — in-process `app.handle(new Request(...))` helper.

## Edge runtime integration

SupaCloud's edge runtime (`@supacloud/edge-runtime`) supports Elysia as a
first-class function framework. Default-export the Elysia instance from your
function entrypoint and set the activation manifest to:

```json
{ "framework": "elysia" }
```

The runtime then routes requests through `app.handle(request)` instead of a
plain `fetch` handler.
