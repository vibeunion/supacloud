# Official Angular reactive integration

SupaCloud's default RxJS transport and SDK support is documented in
[REACTIVE.md](./REACTIVE.md). This integration adds native Angular state and
lifetime interoperability without replacing the framework-neutral entries.

## Choose the entry for the host

| Entry | Purpose |
| --- | --- |
| `@supacloud/app/angular` | Public Angular Signals, effect, Resource, DI and RxJS interop |
| `@supacloud/app/rxjs` | Native Signals and subscriptions owned by an explicit SupaCloud cleanup scope |
| `@supacloud/app/reactive` | Framework-neutral owner-signal cancellation and bounded transport bridge |
| `@supacloud/js/reactive` | Existing SDK query/task observation; no second SDK implementation |
| `@supacloud/app/browser`, `/contracts`, `/execution` | Existing isolated interfaces; no new reactive re-exports |

The Angular entry re-exports the upstream implementations. It is not an Angular
compatibility shim. Its `effect` returns an `EffectRef` and uses Angular scheduling;
`toObservable`, `resource`, `rxResource` and `effect` require the documented Angular
host/injector facilities. A bare SupaCloud injector does not automatically provide
all Angular scheduling services. No Zone.js or private Angular API is introduced.

The root entry's existing synchronous Signals/effect/resource remain unchanged
for compatibility. Do not mix dependencies between that graph and native Angular
Signals. Migrate a coherent feature, including its effects and tests, rather than
blindly rewriting import paths. Native `resource`/`rxResource` are for reads;
reactive parameter changes must never submit or retry a business command.

## Explicit cleanup without an Angular component host

```ts
import { createDestroyRef } from '@supacloud/app';
import { computed } from '@supacloud/app/angular';
import { toScopedSignal } from '@supacloud/app/rxjs';
import { Subject } from 'rxjs';

const scope = createDestroyRef(); // the calling host owns and must destroy this
const updates = new Subject<number>();
try {
  const progress = toScopedSignal(updates, {
    destroyRef: scope,
    initialValue: 0,
  });
  const complete = computed(() => progress() >= 1);
  updates.next(1);
  console.log(complete());
} finally {
  await scope.destroy();
}
```

`takeUntilDestroyed(scope)` requires an explicit owner; it never silently selects
an application singleton when the intended lifetime is a connection/request/job.
With an AbortSignal, consumption stops synchronously on abort, before asynchronous
resource disposal completes. An already-destroyed owner never starts a cold source.
Early unsubscribe removes the lifetime registration. Without a signal, an existing
onDestroy-only owner remains supported. Cancellation of underlying I/O requires an
I/O implementation that observes its signal or unsubscribe callback.

`createDestroyRef().destroy()` retains its public signature. It now shares one
completion Promise across repeated calls, attempts all callbacks in reverse order,
and rejects with an AggregateError containing cleanup failures. Callers must await
or observe this Promise. A callback must not await its own destroy Promise. Runtime
application initialization/draining policy is a separate concern.

## Reuse the official SupaCloud SDK

```ts
import { toSignal, type Injector } from '@supacloud/app/angular';
import { observeTask } from '@supacloud/js/reactive';
import type { SupaCloudTaskReceipt } from '@supacloud/js';

export function bindTask<TResult>(task: SupaCloudTaskReceipt<TResult>, injector: Injector) {
  return toSignal(observeTask(task), { injector });
}
```

Pass an EXISTING SDK receipt; task submission stays an explicit awaited command.
Every Observable subscriber owns a separate SDK subscription. Unsubscribe stops
observation, not the server-side task. Authorization, project binding, transport,
reconciliation, result decoding and error behavior remain owned by the SDK's
existing `/reactive` entry. There is no new SDK `/rxjs` implementation here.

The supplied injector must belong to the actual component/feature owner. Native
`toSignal` subscribes immediately and cleans up with that owner. Its latest state
is not a durable event log. Do not use reactive retries for non-idempotent writes.

## Generator and AI rules

Prefer the official entries for new Angular reactive features. Keep legacy
behavior explicit. Generate an owned subscription and cancellation/cleanup tests
with every long-lived source. Keep commands outside parameter-driven effects or
resources. Never infer authorization from client-side state or share sensitive
replay caches across projects. Use async/await for one business result and RxJS
for event composition. The existing default RxJS starters remain unchanged.

This change does not install an Angular frontend, rewrite Svelte/React components,
introduce another CLI, implement a migration engine, or add MCP/Forms/CDK tooling.

## Verification

With repository dependencies installed and local contracts built:

```sh
cd packages/app
bun run typecheck
bun run typecheck:test
bun test src/scope_cleanup.test.ts src/rxjs.test.ts src/angular_bundle.test.ts
bun test src/browser_bundle.test.ts src/contract_bundle.test.ts src/execution_bundle.test.ts
bun test
bun run build
```

Also run the existing packed reactive consumer and public-API gates. The new APIs
are subpath-only. Angular and RxJS are externalized in the new output, and in the
app runtime output, to avoid shipping a second Angular DI/reactive identity.
Frozen dependency installation, real Angular runtime behavior and packed consumers
must be verified; standalone cleanup tests alone do not establish compatibility.

References: public APIs in `@angular/core` and `@angular/core/rxjs-interop`;
https://angular.dev/ecosystem/rxjs-interop and https://angular.dev/guide/signals.
