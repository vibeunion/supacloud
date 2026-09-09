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
