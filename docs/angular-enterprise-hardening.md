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
Editor positions are line-only, zero-based LSP-shaped data; they are not claimed
as exact character spans. This is an adapter, not a new language-server process.

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
