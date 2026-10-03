# Explicit Edge Function Application Lifecycle

Status: **PROPOSAL**. This document does not add runtime support.
Updated: 2026-10-03.
Source review baseline: `c4b6d727`.

## Problem And Existing Behavior

The application adapter already exposes awaited `initialize()` and `destroy()`
with pending-work accounting. That does not connect an application's teardown
to its enclosing Edge Worker.

At the reviewed baseline:

- `packages/edge-runtime/worker-executor.ts` caches the imported handler,
  acknowledges preheat after module loading, and deletes matching cache entries
  on invalidation. There is no explicit application lifecycle export contract.
- A `retire` message aborts the current request, stops receiving messages and
  closes the parent port. It does not await cached applications' teardown.
- `packages/edge-runtime/worker-pool.ts` already drains requests, replaces
  retired workers and has a retirement-age/count fail-safe. Its `shutdown()`
  bounds request drain and signals retirement, but does not await an application
  cleanup acknowledgement.

This is a missing application/host bridge, not an absence of request cancellation
or cooperative Worker retirement. The generic application lifecycle proposal in
[application-lifecycle-and-diagnostics.md](./application-lifecycle-and-diagnostics.md)
is broader; this proposal is specifically about hosting Functions in Edge Workers.

## Opt-In Contract

Proposed named module export, not an API available in today's runtime:

```ts
interface EdgeFunctionLifecycle {
  initialize(): void | Promise<void>;
  destroy(): void | Promise<void>;
}

export const supacloudLifecycle: EdgeFunctionLifecycle = {
  initialize: () => app.initialize(),
  destroy: () => app.destroy(),
};

export default (request: Request) => app.handle(request);
```

The explicit closures preserve the receiver and make resource ownership visible.
Do not inspect arbitrary handlers for `close`, `stop`, `dispose` or `destroy`.
Legacy function, `handle`, `fetch` and captured `Deno.serve` handlers keep their
existing behavior when the named export is absent. A present but malformed export
must fail loading, not silently degrade to a lifecycle-free function.

The host owns invocation ordering. The application continues to own DI ordering,
borrowed-resource rules, pending work and business receipts. Lifecycle hooks do
not introduce another scheduler or durable job ledger.

## State And Readiness

Each imported application instance has a record scoped to the Worker and the
full module identity: function, artifact path/version/digest and environment
proof. Two versions, two environment revisions or two Workers are not one owner.

State transitions:

```text
loading -> initializing -> ready -> draining -> destroying -> closed
                    \-> failed -> destroying -> closed or quarantined
```

Concurrent loads share the initialization promise. Only a ready instance may
enter the request-context factory or handler. Initialization failure prevents
admission and attempts cleanup of partially initialized resources. Applications
must make `destroy()` safe after a failed initialization, including when their
own initialization routine has already performed rollback.

If preheat initializes an opted-in application, it must await readiness and report
initialization failure. Existing `module_loaded` attestation only means module
loading; do not silently redefine it as application readiness. Any readiness
attestation extension needs a separately versioned protocol and consumer update.
Hooks must not perform business commands merely because preheat was requested.

## Isolation And Serialization

Cleanup must execute under the same function identity and captured environment
revision as initialization, including project-root restrictions, injected
environment, outbound-host policy, TLS policy and tenant log attribution.
Do not run cleanup with the next request's secrets or host-process defaults.
Do not retain request credentials, request bodies or request-bound capabilities
as application-level cleanup state.

The executor currently changes process/compatibility globals around work.
Lifecycle support therefore needs serialized tenant-context transitions, not
independent async event callbacks which restore globals over each other.
Cancellation must still interrupt an active operation immediately; it must not
wait behind a serialized request that is waiting for its abort signal.

Cleanup hooks are awaited directly. They must not rely on untracked
`EdgeRuntime.waitUntil` work surviving teardown. On a timeout, the hook's promise
has not necessarily stopped executing: quarantine that Worker rather than restore
another tenant context and reuse it.

## Retirement And Invalidation

1. Stop admission for the affected instance or Worker.
2. Request cooperative cancellation and retain truthful pending-work accounting.
3. Await safe request/background settlement within the host's drain budget.
4. Invoke and await application cleanup while its tenant context is still owned.
5. Release cache ownership and report cleanup completion, then close the Worker.

Normal retirement, process shutdown, generation rotation, project/function
invalidation and LRU eviction must all follow this ownership rule. Invalidating
a busy instance cannot destroy resources used by its current request.

A lifecycle-bearing instance must not be forgotten on cache deletion or artifact
verification failure. Failed/expired cleanup removes the Worker from scheduling
and leaves an explicit incomplete outcome; it must not receive a success ack.
Legacy cache entries need not incur application cleanup.

Deleting the runtime's Map does not evict the JavaScript module loader's cache.
Reimporting the same URL after destroying its application can return that same
closed object. Prefer Worker replacement for invalidated lifecycle-bearing
instances until fresh-instance creation is implemented and tested. Do not treat
a URL query nonce as proof that all transitive application singletons are fresh.

Duplicate retirement/invalidation signals share one teardown operation per
instance. Cleanup failure for one instance must not suppress cleanup of other
safe-to-clean instances. A non-cooperative active request must not have its
resources released underneath it simply to report successful shutdown.

## Deadlines And Outcomes

Startup and cleanup use host-controlled finite budgets. Tenant exports cannot
increase those budgets. Exact defaults must be agreed alongside the existing
request, drain and retirement-age limits, not independently hard-coded here.

One monotonic shutdown deadline must cover drain and cleanup across all entries;
do not multiply a per-entry timeout by the cache size. The parent waits for the
cleanup outcome or Worker exit up to this budget. Distinguish completed cleanup,
hook failure, deadline expiry and Worker crash. Closing a port, receiving a normal
HTTP response or returning from `shutdown()` is not itself cleanup evidence.

Keep the existing Worker retirement fail-safe. A Promise timeout is neither
cancellation of arbitrary JavaScript nor proof that a process exited. Record only
bounded operation metadata and non-secret identifiers; never log environments,
tokens or hook-provided arbitrary diagnostic objects.

## Required Acceptance Before Enabling

These scenarios are requirements, not executed tests:

| Scenario | Required evidence |
| --- | --- |
| Legacy handler and framework exports | Unchanged request behavior without opt-in |
| Slow initialization | No handler admission or ready acknowledgement before completion |
| Concurrent preheat/request | One initialization for the same owned instance |
| Initialization failure | No admission; cleanup attempted; failure not marked ready |
| Normal retire and shutdown | Async cleanup completes before successful acknowledgement |
| Busy invalidation | Admission stops; existing work remains visible until safe settlement |
| Same-identity reload | No request is served by the previously destroyed instance |
| LRU eviction and artifact rejection | Owned instances are cleaned or Worker is quarantined |
| Repeated cancellation/retirement | No duplicated cleanup invocation or false idle state |
| Throwing/hanging cleanup | Bounded incomplete outcome; no reuse under another tenant context |
| Different functions/environment revisions | Correct cleanup environment, TLS/egress policy and logs |
| Process exit | Parent observes actual cleanup/exit result, not only port closure |

Use real Workers and `WorkerPool` integration fixtures, not only callback mocks.
Include timeout churn and post-replacement request success. Authoritative artifact
loading also needs the existing Linux descriptor-bound path; local legacy tests
on macOS cannot establish that acceptance.

## Decisions And Rollout

Before implementation, review the named export contract, host deadline defaults
and whether lifecycle-aware preheat introduces a versioned readiness attestation.
The proposed safe initial invalidation policy is whole-Worker replacement.

After agreement, implement executor ownership and parent acknowledgements
together, with the acceptance fixtures above. Then add an opt-in application
example and verify a packaged candidate. Do not automatically rewrite existing
Function exports or advertise production graceful shutdown from a documentation
merge. Rollback of an implemented bridge removes the opt-in from new artifacts;
existing owned instances still require a bounded retirement attempt.
