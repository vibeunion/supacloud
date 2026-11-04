# Portable application execution / 独立应用执行管线

`@supacloud/app/execution` is an opt-in, transport-neutral entry point. It does not
load Elysia, Angular, TypeBox or a reflection container. Existing compiler-emitted
`aspectPipeline` functions and the `@supacloud/elysia` root API remain supported.
This is an additive migration path, not a replacement compiler or a new DI framework.

## Keep the two boundaries separate

| Boundary | Responsibility |
| --- | --- |
| Elysia native Plugin / Macro / lifecycle | HTTP validation, HTTP context extraction, rate limits, response mapping and access telemetry |
| Application execution | Authorization and project binding, receipt replay, transaction boundaries, command audit, module/command aspects |
| Durable adapters and scheduler | Persistent receipts, atomic database work, external-effect reconciliation, explicitly configured retry policies |

Elysia stays pinned to **`2.0.0-rc.1`** in the adapter. Use Elysia 2 object-style
`.macro({ ... })`, `derive` rather than `resolve`, string hook scopes such as
`"plugin"`, and `.post(path, options, handler)`. Do not copy 1.x lifecycle APIs.
There is deliberately no replacement HTTP abstraction or decorator dependency.

## Reuse one application executor

```ts
import {
  createCommandPipeline,
  type CommandPipelineGovernance,
} from '@supacloud/app/execution'
import { createApplication } from '@supacloud/elysia'

// Construct these ports at the composition root. The authorizer must verify
// the principal and project binding for every call, including receipt replays.
// Database/receipt/audit ports must supply the declared durable semantics.
export function wireApplication(
  ports: CommandPipelineGovernance,
  modules: Parameters<typeof createApplication>[0]['modules'],
) {
  const execute = createCommandPipeline(ports)
  const http = createApplication({ modules, commandExecutor: execute })
  return { http, execute }
}
```

Use **either** the existing `commandGovernance` convenience wiring **or** a complete
portable `commandExecutor` like this. Do not pass both for the same governance
policy: the host composes them, which would apply authorization/audit twice.
The `commandExecutor` extension is already inside the HTTP command boundary;
compiled module and command aspects run only after its authorization succeeds.

A non-HTTP caller can reuse the same executor without manufacturing a Request:

```ts
const result = await execute({
  command: {
    name: 'orders.update',
    permission: 'orders:write',
    transaction: 'required',
    idempotency: 'required',
    audit: 'orders.update',
  },
  input: { body: input, params: {}, query: {} },
  requestContext: verifiedExecutionContext,
  services,
}, () => updateOrder(input))
```

`verifiedExecutionContext` must come from a trusted verifier/resolver or a
validated durable job envelope. Never promote a client-supplied project header
to authority. The pipeline requires an authorizer; it does not invent identity,
project ownership, permissions or persistence. Adapt HTTP-only ports that read
`invocation.request` before using them with jobs.

## Explicit aspects, no service-method interception

```ts
import { composeAspects } from '@supacloud/app/execution'

const aspects = composeAspects(
  async (context, next) => {
    // Explicit application behavior; no Elysia Context is required.
    const result = await next()
    return result
  },
)

const result = await aspects({ kind: 'job', name: 'reconcile', input }, handler)
```

The first aspect is outermost. This function is compatible with an existing
hand-authored compiled descriptor's `aspectPipeline` slot. Compiler-generated
pipelines are retained; there is no runtime discovery, registration or weaving.
For commands, put aspects inside the authorized handler continuation, not around
the complete executor. Calling a raw service method is still a raw call: it does
not magically acquire governance. Route every governed entry through the executor.

## Compile framework features instead of adding a runtime framework

SupaCloud uses its own application declarations, informed by NestJS and AdonisJS,
to target the existing Elysia host and static DI factories. It does not accept
those frameworks' decorators or provide their full runtime compatibility.
The generated execution plan is inspection metadata; the request path uses the
already generated invokers and pipelines, without reflection, `Proxy`, or runtime
pointcut discovery.

| Framework feature | Compile-time representation | Elysia/runtime boundary |
| --- | --- | --- |
| Nest module/provider graph | `ApplicationGraph`, topological module order, static provider factories | Elysia receives compiled module descriptors |
| Nest controller/decorator routes | compiled route descriptor and direct invoker | Elysia plugin registers routes and lifecycle hooks |
| Nest guard / Adonis middleware | explicit HTTP policy declarations and command permissions | native Elysia hooks and authorization adapters |
| Nest interceptor / Adonis hooks | module, route, command, and job `around(context, next)` aspects | one generated pipeline call |
| Nest pipes / Adonis validators | input/output schemas and parameter transforms | Elysia validates and maps the HTTP value |
| Nest exception filters | declared response/error contracts | adapter error mapper and Elysia `onError` handle runtime errors |
| Nest lifecycle hooks / Adonis boot hooks | generated initialize/destroy plans | application startup and teardown |
| Nest custom providers | constructor-injection factory, value/factory/existing provider descriptors | Elysia composition root supplies external tokens |
| Nest jobs / Adonis queues | compiled job descriptor with scope, timeout, attempts and idempotency | durable scheduler owns delivery and retry |

The compiler may reject an incomplete declaration, but it must not claim runtime
success. Authorization, transaction commits, receipt replay, external effects,
and queue delivery remain runtime adapter responsibilities. This keeps the
compiler strict about structure while production truth stays in durable boundaries.

Angular supplies DI semantics for the runtime application API. Compiled server
factories use explicit constructor calls without an injector on the HTTP path.
The compiled environment scopes have no Angular element-injector tree; `@Host()`
does not introduce a DOM boundary. Angular Router metadata such as `canMatch` is
not automatically executable by the Elysia adapter. Use its supported HTTP policy
contract for HTTP checks and the command executor for business authorization.

Generated modules also contain a static `registerRoutes(register)` callback. The
Elysia adapter requires this callback for modules with HTTP routes and does not
fall back to traversing `controllers[].routes[]`. If a custom descriptor reports
`COMPILED_ROUTE_REGISTRATION_REQUIRED`, upgrade compiler and adapter together and
recompile. See the [route registration migration](../elysia/README.md#static-route-registration-migration).

## Versioned compilation contract

`app.manifest.json.executionPlan` version 1 records provider scopes and edges,
ordered initialization and destruction, resolved module boundary rules, route
registration and lifecycle hooks, Effect declarations, and command adapter
requirements including conditional RPC branches. `renderApplication()` also
returns the typed `executionPlan` for in-process tooling. Module and route arrays
retain factory initialization and registration order. The inspection/context
pack and manifest use the same execution-stage calculation.

Routes with an explicit command binding have `commandBoundary: "route"`.
Feature routes that invoke a command inside their handler have
`commandBoundary: "handler"`; their HTTP stages do not claim that authorization
wraps the entire handler. Elysia host options can add hooks or force a pipeline.
Guards and resolvers recorded as metadata do not become executable HTTP hooks.

Delivery rendering calls `validateExecutionManifest(plan, commandCapabilities)`
before bundling. Supply explicit permission, transaction, audit and idempotency
capabilities, including named RPC adapters and external reconciliation. Missing
capabilities fail closed. This API consumes a compiler-produced typed plan;
external JSON needs its own input validation. These checks validate declarations,
not database reachability, successful transactions or durable audit persistence.

### Command boundary migration (`SC4029`)

The analyzer rejects typed raw `@Command` method access outside its governed
boundary, including method extraction and destructuring. The check runs on
incremental analysis too, and `writeOnError` cannot emit a bypassing application.
Use a route explicitly bound to that command, an `executeCompiledCommand`
handler with a literal command name, or a durable facade whose method only
forwards to a readonly `createTransactionalCommand` / `createExternalCommand`
executor. Import aliases are supported; matching a method name alone is not
proof of governance. Ordinary ungoverned service calls are unaffected.

This is a conservative check of typed class method and callable field references within the compiled
source root. It is not whole-program information-flow verification: structural
type erasure, dynamic JavaScript, external packages and reflection cannot be
proven safe by this check. Durable adapter tests and runtime authorization remain
required. Keep raw business implementations private to the governed boundary.

## Execution guarantees and limits

Authorization always runs before receipt lookup/replay and before business
aspects. Missing declared transaction, idempotency or audit adapters fail closed.
RPC adapters must advertise each required capability; inherited registry keys
are not accepted. Storage adapters, not the aspect system, implement atomicity.

The standard order is authorization, idempotency, transaction, handler, success
audit, transaction completion, then receipt completion. Success audit is awaited
inside the transaction. Failure audit is awaited after the failure; if it also
fails, an `AggregateError` retains both failures and the original cause. An HTTP
response, HTTP `afterResponse` callback or telemetry event is not a durable audit.

Each `next()` is single-use and closes when its owning middleware settles. An
unawaited in-flight continuation is drained and rejected, so the caller cannot
release its outer scope while already-started work is still running. Middleware
must still return or await `next()` before committing or releasing its own
resources. These guards cannot undo a commit performed by an incorrect adapter.

There is no automatic retry, cancellation, exactly-once guarantee or distributed
transaction here. A database rollback cannot undo an external effect. Ambiguous
external outcomes must go through the existing durable command/recovery boundary,
not a second call to `next()`. Stream consumption is also outside a handler's
settled promise unless the application explicitly includes it in that promise.

`onExecution` / `ExecutionObserver` remains best-effort metadata-only telemetry.
Observers cannot change the result. Request bodies, credentials, results and error
objects are not emitted. The Elysia adapter re-exports the same portable telemetry
implementation while retaining its previous import paths.

## Verification

```sh
bun run scripts/build-command-dependencies.ts elysia
cd packages/elysia
bun install --frozen-lockfile
bun run typecheck
bun run typecheck:test
bun run test:conformance
```

`test:conformance` includes the native Elysia 2 Macro integration, compiled-command
integration, portable execution behavioral tests and dependency-free bundle test.
Existing adapter and compiler suites should also pass before merging.

## 中文实施边界

本次新增可直接调用的应用层执行入口，并复用现有 `commandExecutor` 和编译产物契约。
应用执行入口不依赖 Elysia；Elysia 2 beta 只处理 HTTP 宿主职责。没有引入 Nestelia、
反射容器或新的装饰器框架，也没有改写现有编译器生成链。

事务、幂等、审计、项目身份绑定仍由明确配置的适配器和授权器负责；它们不是自动获得的能力。
现有使用 `commandGovernance` 的应用不会被自动迁移。需要跨 HTTP、任务、Workflow 复用时，
在组合根创建同一份 portable executor，并确保所有业务入口调用它。
