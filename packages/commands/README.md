# @supacloud/commands

Storage-independent durable execution. Depends only on `@supacloud/contracts`;
no SQL driver, HTTP server, Svelte lifecycle or scheduler is bundled.

## Execution

- `createTransactionalCommand`: one store transaction contains authorization,
  business mutation, validated receipt and audit. Use the provided transaction
  for every local business/audit write.
- `createExternalCommand`: commits intent before one send. Duplicate execution,
  reconciliation, audit recovery and background recovery never resend.
- `createCommandRecoveryJob`: bounded `run()` handler for the host's existing Job
  executor. Explicit tenant, named handlers, worker authorization, leases,
  backoff, sanitized alerts and completed-input retention.

All factories require a `store`, domain input/result decoders, an `inputCodec`,
an explicit `"allow"` / `"deny"` policy and domain audit metadata. A thrown or
invalid authorization decision means `COMMAND_UNAVAILABLE`, never denial.
Choose `plaintextCommandInput` only for non-secret inputs; use a host-owned
authenticated encryption codec and key lifecycle otherwise. Fingerprints are
not encryption; receipts/results and audit details need their own data policy.

PostgreSQL integration uses `createPostgresCommandStore` from `@supacloud/db`.
The storage interfaces are owned by contracts and re-exported here as types.
Other stores must provide equivalent transaction and receipt guarantees; merely
implementing the TypeScript interface does not prove persistence correctness.

## Recovery

Interactive methods reauthorize the original actor. Worker `recover` requires
independent `authorizeRecovery(principal, reference, transaction)` and keeps
the original receipt identity. No recovery policy means denial. Neither method
assumes that a cancelled or failed request rolled back.

The Job handler returns a report; the host must schedule runs and send its alerts
to existing monitoring. Bound lookup duration at the transport layer. Lease expiry
can duplicate read-only queries, not dispatches. Pending/unknown/audit-pending
inputs are never removed by completed-input retention.

Redaction keeps fingerprints and receipts: same-input explicit replay deduplicates;
different input conflicts; reference-only lookup returns `COMMAND_INPUT_EXPIRED`.
Never issue a new operation just because the old input expired.

See [breaking changes, schema upgrade, release and rollback](../../docs/command-migration.md).
Run `bun run typecheck`, `bun run typecheck:test`, `bun test` and `bun run build`.
