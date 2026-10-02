# Reactive integration and asynchronous defaults

The approved [async/stream/governance ADR](adr/2026-10-02-async-stream-governance.md)
supersedes the blanket recommendation to use RxJS in every starter. Ordinary
asynchronous business calls use Promise results; continuous event consumption
and byte transport prefer AsyncIterable and Web Streams. RxJS remains an official
option for complex event composition and explicit reactive/Angular integration.

## Implementation transition

At baseline `6183f3e7e985f1fb06a6b31aaf2bab125bb1b34d`, command/HTTP/edge starters
still install RxJS and emit REACTIVE.md, AGENTS.md and reactive cleanup tests.
The app and SDK still declare RxJS directly. This documentation change does not
remove those dependencies, alter generated files or retire existing adapters.
Template convergence and installation-graph separation have separate acceptance
criteria in the ADR. Not importing RxJS is not proof it is absent from installation.

## Official entries

- [Framework integration](../packages/app/REACTIVE.md): `@supacloud/app/reactive`
  provides `takeUntilAborted` and a bounded `toReadableStream` transport adapter.
- [SDK calling conventions](../packages/supacloud-js/REACTIVE.md):
  `@supacloud/js/reactive` provides `observeQuery` and `observeTask` without
  replacing the existing `createSupaCloudClient` instance or Promise APIs.

When choosing this integration, use native operators from `rxjs`. Keep normal browser/contracts entries isolated
from reactive imports. All subscriptions have explicit owners; pass cancellation
to native I/O and keep buffers and payload sizes bounded. Do not globally replay
project/user data or automatically resubscribe business writes.

## SupaCloud JS boundaries

The actual package is `@supacloud/js`. Database/Auth/Storage calls remain on
`client.supabase`; platform tasks/commands remain on their existing SDK APIs.
`observeQuery(signal => client.supabase.from(...).select(...).abortSignal(signal))`
creates a fresh native query per subscription, preserves the response envelope
and row inference, and sends resolved error envelopes to the error channel.
Submit a task once with the existing SDK, then call `observeTask(receipt)`.
Unsubscribing observation never cancels, retries or resubmits the server task.

Do not turn `@supacloud/js/task-events` durable `watch` into a push stream with
`from()`: `onCursor` is a processing acknowledgement, while RxJS `next` does not
await an asynchronous subscriber. Keep durable processing on the existing
for-await path. These adapters are not an event journal or transaction boundary.

## Verification and release

Package tests cover lazy queries, real Supabase query builders, typed task
snapshots, cancellation, synchronous teardown races, errors, bounded overflow
and browser dependency isolation. Generated starter tests cover owner cleanup.
Use matching released packages or the packed candidate gate; adding source code
is not a claim of npm publication, production transport acceptance or deployment.

The packed-consumer gate runs real SDK implementations with synthetic HTTP
responses, not a live production database. It checks framework declarations with
`strict: true` and `skipLibCheck: false`, and compares the full SDK consumer with
an independently compiled native Supabase-only baseline using the same DOM libs.
A known upstream `PublicKeyCredentialFuture<T>` WebAuthn/DOM TS2430 conflict is
reported explicitly only when that exact diagnostic is independently reproduced
and the adapter consumer has identical diagnostics; all additional errors fail.
This is a no-new-diagnostics regression gate, NOT full SDK strict declaration
acceptance. No peer declarations are patched and library checking is not disabled.
When the native baseline compiles cleanly, the full consumer must also compile
cleanly. Selected-row and decoded-task negative type assertions remain enforced.
