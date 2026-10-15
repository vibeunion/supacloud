# @supacloud/contracts

Dependency-free command contracts for browser and server applications. Installing
this package does not install Angular, Svelte, a database driver or a DI runtime.

## APIs

The root entrypoint exports protocol types, decoders, `CommandError` and storage
port types only. Import optional client APIs from `@supacloud/contracts/client`
and lock implementations from `@supacloud/contracts/browser`. None are re-exported
from the root. This is a breaking import-path change with no framework dependency.

- `createAuthoritativeCommandClient`: validate input, acknowledgement and authority
  independently. By default even a valid acknowledgement triggers one authoritative
  lookup. One invocation sends at most one write and one lookup; it never retries.
- `createPendingCommandClient` (`/client`): combine that confirmation flow with an
  existing JSON pending marker. Input must be persisted and read back before sending;
  an existing or corrupt marker blocks a new write. Confirmed authority or definitive
  write denial clears only the unchanged marker. Unknown outcomes retain it.
  Supply `responseAuthority` when explicitly using `confirmation: "response"` and
  the direct committed result differs from the lookup receipt. Both paths still
  require the domain matcher. `unknownError(input, lookupFailure)` maps a failed
  lookup without mistaking a missing/malformed receipt for a network failure.
- `createPendingCommandRecovery` (`/client`): manually reconcile after a reload
  using only `input`, `authority`, `matches` and a `lookup` transport. The returned
  zero-argument function reads the stored identity, performs at most one lookup,
  and returns `{ input, authority }` on confirmation or `null` if no marker exists.
  It never calls a send transport or writes a new marker. Unknown outcomes retain
  the marker and use the same `unknownError` mapping as the pending client.
- `createAuthenticatedFetch`: obtain a current token **before** sending over HTTPS.
  It preserves request credentials and cancellation, rejects redirects, and never
  refreshes/replays a write after 401. The supplied fetch must itself be single-attempt.
- `createCommandScope` (`/client`): `invalidate()` aborts old work without destroying
  a reusable scope; destruction is permanent. Reject stale synchronous
  state commits. Async callbacks are not accepted by `attempt.commit`.
- `createDurableCommandLocks` (`/browser`): persistent operation ownership with an atomic
  coordinator. `release` checks both operation ID and page ownership inside that
  coordinator. Storage failures and corrupt data fail closed.
- `createWebLockCoordinator`: browser Web Locks implementation; no unlocked fallback.
- `decodeDurableCommandReceipt`: runtime-validated pending/unknown/confirmed receipts,
  with separate audit state. Always supply the domain result decoder.
- `canonicalCommandJson`: deterministic, JSON-only persistence input. Rejects cycles,
  undefined, non-finite numbers and non-JSON objects.

`createContractCommandClient` remains a thin legacy protocol export. New work should
use `createAuthoritativeCommandClient`: transport acknowledgement and business
authority need not have the same shape.

## Boundaries

An HTTP status, an acknowledgement or a cancelled request is not proof of rollback.
Only configure `isDefinitiveWriteFailure` for a contract that guarantees no business
effect. A lock is not server-side idempotency. Persist operation identifiers before
sending, namespace locks by tenant/actor/command/target, and clear only after
authoritative confirmation or an explicit domain recovery decision.

Pending markers are UI recovery hints, not a second business ledger. The pending
client does not provide cross-tab atomicity, request timeouts, authorization or
database idempotency. Retain those existing controls; use coordinated durable
locks when cross-tab ownership is required. A cleanup error propagates without
resending. Neither the pending client nor its transports may retry a write.

Manual recovery requires the decoder to preserve the stored JSON values; it must
not mint a new identity, normalize business values or drop fields on reload.
Whitespace and object-key ordering do not matter for that validation. Cleanup
still compares the exact original stored string, so a late lookup cannot remove
a replacement marker. A storage error rejects, even after authority is confirmed.
The result identifies the recovered input, not necessarily the current UI request:
apply the page/session generation guard and reread pending storage before updating
the UI. `null` does not prove success or rollback. No cross-tab atomicity is added;
as with the pending client, the read-only lookup transport must not retry or write.

Existing authentication providers can be retained through `getAccessToken()`.
Do not supply an authenticated SDK transport that secretly retries writes. The
adapter does not make caller-selected URLs trustworthy; use fixed, trusted service
origins, never an arbitrary user-supplied URL with a bearer token.

See [the complete migration plan](../../docs/command-migration.md), including
failure semantics, PostgreSQL adapters, Svelte integration and acceptance commands.

## Validation

```sh
bun install --frozen-lockfile
bun run typecheck
bun run typecheck:test
bun test
bun run build
```
