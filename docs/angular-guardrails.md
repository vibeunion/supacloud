# Angular reactive guardrails and package acceptance

This extends the explicit Angular/scoped entrypoints introduced by #1558. It
does not replace the legacy synchronous Signals at the SupaCloud root entry.

## Create subscriptions once, then derive state

`toScopedSignal()` calls Angular's public `assertNotInReactiveContext()` before
creating its subscription. Calling it in an Angular `computed`/`effect` is
rejected even with an explicit owner and in production mode. Create the scoped
signal once, outside reactive evaluation, then derive from it. An explicit scope
does not require an implicit Angular injection context.

```ts
import { computed } from "@supacloud/app/angular";
import { toScopedSignal } from "@supacloud/app/rxjs";

// task$ observes an existing, already project-bound SDK task receipt.
// owner is the explicitly managed lifetime of this consumer.
const state = toScopedSignal(task$, { destroyRef: owner, initialValue: null });
const progress = computed(() => state()?.progress ?? 0);
```

The Angular entry also re-exports the native `assertInInjectionContext` and
`assertNotInReactiveContext`. They diagnose Angular execution contexts, not
permissions, legacy SupaCloud Signals or arbitrary asynchronous callbacks.
There is no new task scheduler, DI container, error handler or global cache.
SDK submission, cancellation, retries, project checks and durable task-event
acknowledgements remain unchanged.

## Verify the installed package, not just source imports

After building the contracts, app, testing, delivery and compiler candidates, run:

```sh
bun run scripts/check_angular_consumer.ts
```

The check packs the actual app/contracts/testing/compiler candidates and their local
delivery dependency, installs them outside the
workspace with a real Angular host and RxJS, then exercises public package
entrypoints. It uses the existing `installStarterConsumer` and command runner,
not a second installation or migration framework.

Acceptance includes JS and declaration entrypoint existence, strict NodeNext
consumer declarations for the Angular/scoped entries with `skipLibCheck:false`, native API identity, native
computed updates, owner cancellation, rejection before additional subscription
or cleanup registration, and already-aborted source suppression. Development
and production mode run in separate processes. Browser bundling must resolve
one physical Angular core and must not pull in the server root/injection context.
A second strict Bundler consumer checks the root-shared HTTP facade, actual
parent/child injector requests, pending-work ownership and shared editor/AI
diagnostics. It does not claim NodeNext support for every legacy root declaration.
The existing SDK and framework-neutral reactive consumer gates remain unchanged.

The read-only Reactive Integration workflow runs this check and now includes
PRs targeting `feat/default-rxjs-sdk`, so the stacked Angular PR has an execution
path. Permissions remain `contents: read`, with credentials not persisted on
checkout. No write-enabled workflow, deployment or publication was introduced.

This gate verifies the installed candidate tuple, not every version in the
manifest's semver range. Externalizing Angular alone does not establish shared
runtime identity. A future peer-dependency migration must include regenerated
lockfiles and real consumer installation evidence; this change does not alter
that dependency contract or silently modify existing dependency versions.

The accompanying [enterprise hardening](./angular-enterprise-hardening.md)
adds compiler diagnostics, editor data adapters, pending-work accounting, a test
backend and a deterministic HTTP import migration. Whole-program side-effect
analysis and a standalone language-server process remain outside this change.
