# Application lifecycle: runtime compatibility path

## Decision and scope

Learn from Aponia's instance-based lifecycle and ordered shutdown without adding
Aponia dependencies or another application model. This change hardens the existing
`bootstrapBun`, `EnvironmentInjector` and `runInScope` APIs. Their public signatures
and provider ownership model stay unchanged. Await readiness and cleanup completion.

This is **not** a lifecycle implementation for compiler-generated modules. Static
factories, the Elysia HTTP/Job adapters, Worker transport, application execution and
Devtools contracts remain unchanged. Do not insert runtime injection APIs into
compiled modules. See [Application Framework](application-framework.md) and
`packages/app/EXECUTION.md` for those separate paths.

## Lifecycle rules

`provideLifecycle` initializes each registered instance once per injector, even
when repeated registrations or aliases name it. Existing provider resolution still
owns identity; this does not introduce a process-global singleton or ordering graph.

Tracked SupaCloud `onDestroy` hooks execute in reverse construction order, awaiting
each asynchronous hook before releasing the next instance. Constructor dependencies
are released after the local instances built from them. Independent services follow
their actual construction order; undeclared dependencies cannot be inferred. Hook
lookup and execution failures are collected without preventing later hooks. The
injector preserves its `AggregateError` cleanup contract and ordered failures.

Angular still owns synchronous `ngOnDestroy`. That phase runs first, then
`DestroyRef` cleanup, then SupaCloud's ordered `onDestroy` phase. Ordering guarantees
apply to the last phase only. Do not split a dependency-sensitive release sequence
across these phases or release the same resource in multiple phases. Existing
synchronous destroy-signal cancellation is retained. `destroy()` initiates cleanup;
use `await destroyAsync()` to observe completion and failures.

Repeated and fire-and-forget reentrant `stop()` / `destroyAsync()` calls join one
completion operation. Hooks must not await or return their own application's
stop/destroy promise: that creates a circular wait. Hanging cleanup still needs a
host-owned deadline/cancellation policy; dependents are not released underneath it.

Bootstrap awaits initialization before `serve`, and cleans up when initialization
or serving fails. Instances that never listened can still be closed. A `serve`
callback that acquires a resource then throws before returning its handle owns
cleanup of that unreturned resource. Bootstrap cannot discover it.

`server.stop(true)` is unchanged. This change does not implement graceful HTTP or
WebSocket draining, worker shutdown, startup cancellation or shutdown timeouts.
Concurrent manual initialization and destruction is not newly guaranteed: await
startup before initiating teardown.

## Errors and resource ownership

Startup, serving or scoped work retains its original thrown value when cleanup
succeeds. Cleanup-only failures also retain their identity. When both fail, return
`AggregateError([primary, cleanup], message, { cause: primary })` without flattening
nested injector errors. Non-Error throws, including `undefined`, are preserved.
These are process-side diagnostics, not a public HTTP error envelope.

Signal-triggered shutdown observes its rejection, changes a successful/absent exit
code to `1`, preserves an existing nonzero exit code, and reports a fixed message
without arbitrary resource-error text. Calling `app.stop()` still returns the
structured failure. No `process.exit` is forced.

Plain reads of inherited providers do not make a child own its parent. A borrowed
`useValue` object's SupaCloud `onDestroy` is not adopted on a plain read. Explicit
`provideLifecycle` registration remains opt-in; factory-returned instances retain
existing tracking. Do not register a parent-owned resource as a child lifecycle
or return borrowed resources from an owning factory. Angular's `ngOnDestroy`
ownership and `DestroyRef` callback semantics are not redesigned here.

## Verification and rollback

With the repository's pinned dependencies installed in `packages/app`:

```sh
bun run typecheck
bun run typecheck:test
bun test src/lifecycle-cleanup.test.ts src/lifecycle-ordering.test.ts \
  src/lifecycle-regression.test.ts src/bun.test.ts
bun test
```

The helper tests use `node:test` and `node:assert`, allowing isolated verification
without Angular or Bun. That check does not establish pinned Bun, real Angular,
server or packed-consumer acceptance. Integration tests exercise actual runtime
injectors, aliases, dependent cleanup, errors, ownership, reentrancy and captured
signal listeners; they never send a real signal. See the PR for executed results.

Revert the lifecycle hardening commit to roll back. There are no schema, data,
generated-artifact, public signature, dependency or configuration changes.

## Reference

Behavioral reference only, Aponia commit `f4e3f0dc644d9748762588501c81621fb70df2f7`:

- `docs/lifecycle.md`
- `packages/platform-elysia/src/application/lifecycle-hooks.ts`

No Aponia source was copied. New project-owned changes follow SupaCloud's
contribution terms. This does not attempt to reproduce its full feature catalog.
