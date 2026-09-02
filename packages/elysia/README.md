# @supacloud/elysia

[English](#english) | [中文](#中文)

## English

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
  ): Record<string, unknown>;
  controllers: CompiledController[];
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

## 中文

`@supacloud/elysia` 是 SupaCloud 应用的 Elysia 运行时适配器：它把 `@supacloud/compiler` 生成的普通数据 `CompiledModule` 转换为 Elysia plugin，并管理 `application` / `request` scope。

本包不依赖 compiler，而是在本地声明并重新导出所需 contract；只要对象满足这些结构即可使用。

### 使用方式

```ts
import { createApplication } from "@supacloud/elysia";
import AuditModule from "./.generated/audit.module";
import CaseModule from "./.generated/case.module";

const app = createApplication({
  name: "case-service",
  modules: [AuditModule, CaseModule],
  deps: { db: createDbClient() },
  requestContext: (request) => ({ request }),
});

export default app;
```

每个模块都会按拓扑顺序实例化并注册为命名 Elysia plugin。定义了 `createRequestScope` 的模块会在每个请求中创建全新的 request scope，不会跨请求复用。

路由完整路径由 `controller.path + route.path` 组成；存在 `body`、`params`、`query` 或 `response` schema 时，适配器会把它们传给 Elysia 做校验。校验失败使用 Elysia 默认的 422 行为。

### Edge Runtime 集成

`@supacloud/edge-runtime` 支持 Elysia Function framework。Function 入口默认导出 Elysia 实例，并在 activation manifest 中设置：

```json
{ "framework": "elysia" }
```

运行时会调用 `app.handle(request)`，而不是普通的 `fetch` handler。
