# Angular-inspired enterprise defaults

This change completes source-level integrations across the five requested work
areas. It does not certify a production deployment or every Angular feature.
Use the published candidate entrypoints only after their CI/consumer checks pass.

## Implementation ledger

| Area | Implementation | Verification |
| --- | --- | --- |
| HTTP API semantics | nearest-parent delegation, shared replay guard, cached HttpContext defaults, provider-oriented `/http` entry | transport/context tests, actual injector tests, packed HTTP consumer |
| Reactive guardrails and shared runtime | unconditional public Angular context assertion; structurally typed owner; external Angular/RxJS; HTTP facade references the package root | negative nesting tests, dev/prod packed identity and strict declaration tests |
| Shared diagnostics | existing `scanRuntimeDi` feeds compile/check/Context Pack; named/namespace/const alias lexical provenance; `/diagnostics` produces one report and LSP-shaped adapter | diagnostics, false-positive, aliases, shadowing and shared repair-payload tests |
| Real scopes and request errors | execute actual generated request/job factories; add a bounded fetch backend to existing `@supacloud/testing` | generated scope integration, expected/duplicate/unsettled/aborted requests, original failure tests |
| Work accounting and migration | explicit owner-bound `/runtime` registry; original `migrateProject` applies `http-provider-entrypoint` | bounded idle waits and cancellation, project preview/write/conflict/idempotence tests |

## Public HTTP configuration

```ts
import { provideHttpClient, withFetch, withInterceptors } from '@supacloud/app/http';

const providers = provideHttpClient(
  withFetch(fetch),
  withInterceptors(async (request, next) => next(request)),
);
```

The root `withInterceptors` remains the legacy array helper, for compatibility
with direct `new HttpClient(config, interceptorArray)` use. The new `/http`
entry returns an `HttpClientFeature` and shares the root HttpClient class and
provider tokens. It is not a second HTTP/DI implementation. The self-package
TypeScript path is build-time only; the published facade leaves the root import
external so the installed consumer resolves one owner.

`withRequestsMadeViaParent()` runs child then nearest-parent interceptors and
retains one logical-request replay budget. An ancestor changing GET into POST
cannot obtain a fresh write budget on a child retry. No parent is an explicit
configuration error. Fetch and parent transport features are mutually exclusive.
Authorization, idempotency, transaction and audit still belong to their existing
executors and SDKs, not to these HTTP features.

## Diagnostics for CLI, editors and AI

Compile/check already return the same `Diagnostic[]` used by Context Pack. The
new `@supacloud/compiler/diagnostics` entry adds `createDiagnosticReport()` and
`toEditorDiagnostics()` over that exact payload and existing semantic repair plan.
Editor positions are zero-based LSP-shaped ranges with source columns when the
compiler has a precise span; this remains an adapter, not a new language-server
process.

The checks identify known imported APIs and lexical bindings, not arbitrary
function names. New errors are `reactive-subscription-in-computation` and
`http-provider-import-mismatch`. Direct Angular runtime DI and reexports found in
the analyzed source set also use the existing SC2012 rule. Type-only imports and
shadowed bindings are not runtime calls. Computed/effect inline callbacks and
immediately invoked closures are inspected; deferred closures and explicit
untracked callbacks are not incorrectly treated as the current computation.

This is intentionally not a whole-program side-effect proof. Arbitrary dynamic
calls, external barrels outside the analyzed file set and business write intent
cannot be reliably inferred. Hoisting subscriptions and selecting authorization
or transaction policies are manual decisions. No speculative code action is
reported as an executable fix. Normal TypeScript/runtime validation remains.

## Work registry

`PendingWorkRegistry` and `createPendingWorkRegistry(owner)` are available from
`@supacloud/app/runtime`, a transport-neutral entry with no Angular/SDK import.
The owner is explicit; create a separate registry for each isolation boundary.

```ts
import { createPendingWorkRegistry } from '@supacloud/app/runtime';

// owner is the actual application/request/job lifetime, not a global fallback.
const work = createPendingWorkRegistry(owner, { capacity: 1024 });
const result = await work.run({ name: 'orders.read', kind: 'request' }, async signal => {
  const response = await client.supabase.from('orders').select('id').abortSignal(signal);
  if (response.error) throw response.error;
  return response.data;
});
```

Registration starts before execution and ends in finally. Original results and
rejections are preserved. `snapshot()` contains only bounded operation names,
kind, local ID, age and blocking status; never register URLs, credentials or
request bodies as names. Default capacity is 1024; admission and waiter overload
fail explicitly rather than grow indefinitely. Operation names are caller-owned
metadata, not an attestation that tasks are correctly classified.

`waitForIdle()` is bounded (5 seconds by default). Background subscriptions do not
block readiness; use `includeBackground: true` for an all-work wait. `close()`
prevents new registrations; `dispose()` also requests cooperative cancellation.
Cancellation does **not** erase unfinished registrations or prove rollback.
A non-cooperative operation stays visible until its actual completion callback.
Close admission before using idle completion as a drain condition. Streaming
connections need their own owners; this does not extend a request transaction.
There is no automatic global Promise instrumentation, new queue, retry engine,
persistent execution state, or implicit public diagnostics endpoint.

## Request testing

`createHttpTestBackend()` is part of existing `@supacloud/testing`. Pass its fetch
to the actual HTTP client or SDK, then use `expectOne`, `expectNone`, `respond` /
`flush`, `error` and `verify`. Matched-but-unsettled requests fail verification.
Unmatched cancellations are only ignored with an explicit verification option.
No real network is used. Keep observing the actual returned Promise; backend
`dispose` deliberately rejects unfinished requests rather than hiding failures.
The request ledger is bounded and intended to be recreated per test.

## Deterministic migration

The original CLI `supacloud-compiler migrate --root . --json` previews the new
`http-provider-entrypoint` rule. Add `--write` only after reviewing the report.
Its 0.12.0 -> 0.13.0 checkpoints describe source formats, not npm package versions.

Only root `withInterceptors` bindings whose references are exclusively direct
`provideHttpClient` feature arguments move to `/http`. Import aliases are kept.
Legacy array consumers stay untouched. Mixed uses and namespace calls become
explicit issues; any issue prevents every project write. Existing conflict
checks, concurrent-edit checks and controlled restoration remain the writer.
A second successful migration changes nothing. Signals/effect scheduling and
resource ownership are not guessed or silently migrated.

## Acceptance and rollback

The read-only Reactive Integration workflow runs app and testing suites, focused
compiler/generation/migration tests, SDK acceptance, and external packed consumers.
It retains frozen installs, no persisted checkout credentials and clean-diff
verification. Extra exports and declarations must exist in the candidate tarballs.
No dependency version, lockfile, deployment, database, auth policy or review
permission is changed. Existing package root/execution/browser/contracts behavior
is preserved except the explicit HTTP bug fixes documented above.

Revert this change to roll back implementation; use version control to revert
applied source migrations. Re-run validation after retargeting or rebasing the
stacked PR. Local syntax/helper tests are not a substitute for Bun, the repository
compiler/Angular versions, packed consumers, or production concurrency tests.

## Default host integration

New application guidance and module Context Packs choose async/await for a single
business result, RxJS for event composition, and `@supacloud/app/angular` inside
an Angular host. Root signals remain legacy compatibility APIs; no scheduler or
existing signal graph is silently migrated. SupaCloud JS still uses the existing
`createSupaCloudClient`, `client.supabase`, command/task Promise APIs and separate
`@supacloud/js/reactive` adapters.

`createApplication()` owns a bounded `pendingWork` registry. It tracks module
startup and compiled requests from context construction through request-scope
cleanup. `app.waitForIdle({ timeoutMs })` observes that registry. `destroy()`
stops admission, requests cancellation, and drains admitted work before releasing
services. `pendingWork.shutdownTimeoutMs` defaults to 5000. A drain timeout
rejects with `PendingWorkTimeoutError`, retains unfinished snapshots and service
ownership, and allows `destroy()` again after the work settles.

Request context factories receive an optional third `AbortSignal`, combining
request disconnect and application shutdown. Existing two-argument factories
remain valid; use the third argument when passing cancellation into custom I/O:

```ts
const app = createApplication({
  modules,
  requestContext: (request, context, signal) => ({ request, signal }),
  pendingWork: { shutdownTimeoutMs: 5000 },
});
```

Workers own their own `pendingWork` registry. Startup, polling/manual claims,
job execution, scope disposal and receipt confirmation are counted. `stop()`
closes admission and cancels cooperative job I/O; its `shutdownTimeoutMs` bounds
the work drain. A timeout leaves the worker stopping and services retained until
a subsequent successful stop. Receipt confirmation retains its own signal so
handler cancellation does not prevent acknowledging an already committed result.
There is no new automatic retry, rollback, durable queue or global Promise tracker.
Custom contexts must forward the supplied signal themselves. Unmanaged native
routes and arbitrary background promises are not automatically registered.
Request accounting ends at the adapter's after-response cleanup boundary, not an
assertion of remote delivery or durable consumption. Service destructors remain
host-defined and are awaited; the timeout bounds admitted-work drainage.

## Validated editor actions and tested consumers

`supacloud-compiler diagnostics [rootDir] --json` emits a shared report, editor
ranges and validated semantic actions without writing source. Angular misuse,
runtime-DI and HTTP-provider diagnostics carry exact UTF-16 source spans; older
line-only diagnostics retain a zero-column fallback. `createEditorCodeActions()`
previews only repairs classified as ready. Missing policy input, stale or
ambiguous source, and manual-only suggestions produce no automatic action.

The `supacloud.applyDiagnosticFix` command arguments contain a semantic `fix` and
`expectedSourceHash`. Save that argument object as JSON and use the existing
`supacloud-compiler fix action.json --root src --write` executor, or call
`applyDiagnosticFix(fix, { expectedSourceHash, rootDir, dryRun: false })` directly.
A changed source hash or semantic precondition rejects application. No editor
extension or language server is installed by this command.

The reactive CI runs packed consumers using the declared Angular dependency
range and the explicit minimum `22.1.5`; each run logs actual installed Angular,
RxJS, TypeScript and Elysia versions. The Angular consumer now installs candidate
Elysia/DB/command packages and executes request cancellation, drain timeout,
repeated shutdown and worker receipts outside the workspace. The separate SDK
consumer continues checking real SDK calls, generic inference and browser
isolation. These are tested dependency combinations, not a claim of compatibility
with every version in the declared range or production deployment acceptance.

Type checking is explicit about upstream limits: Angular/HTTP/diagnostic consumer
projects keep `skipLibCheck: false`; the packed Elysia host uses `skipLibCheck:
true` because Elysia's published declarations are outside SupaCloud's control.
This does not claim every upstream declaration combination is clean.
