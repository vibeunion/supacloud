# @supacloud/commands

## Schema and Execution Policies

`@supacloud/commands/typebox` exports `createTypeBoxTransactionalCommand`.
Pass `schemas: { input, result }` to derive both handler types and runtime
validation from TypeBox. The concrete store transaction type is retained,
including Drizzle `transaction.db`. Typed callers use `execute` / `lookup`;
transport adapters use `executeUnknown` / `lookupUnknown`. Both validate at
runtime without coercion, defaults or transforms.

`createExecutionPolicy` provides explicit cooperative timeouts, classified retries
and a circuit breaker per host-owned operation. Transactional commands accept
`executionPolicy` and forward an `AbortSignal` to the handler; pass it to drivers.
Read retries require classification as `retry` or `rolled-back`; command retries
require a driver-confirmed `rolled-back` failure. Unknown write outcomes and
external dispatches are never automatically retried. Recover via durable receipts.

Timeout requests cancellation but retains ownership until the driver settles.
An uncooperative driver can exceed the timeout. Transactional cancellation is
conservatively reported as `COMMAND_OUTCOME_UNKNOWN`, not proof of rollback.
Circuit `isFailure` should exclude authorization, schema and domain rejection.
Circuit state is local to the policy instance, not distributed.

Storage-independent durable execution. Depends only on `@supacloud/contracts`;
no SQL driver, HTTP server, Svelte lifecycle or scheduler is bundled.

## Execution

- `createTransactionalCommand`: one store transaction contains authorization,
  business mutation, validated receipt and audit. Use the provided transaction
  for every local business/audit write.
- `createExternalCommand`: commits intent before one send. Duplicate execution,
  reconciliation, audit recovery and background recovery never resend.
- `createCommandRecoveryHandler`: handles one already-claimed Workflow recovery
  step. Explicit tenant, named handlers and worker authorization; no claim loop,
  independent leases, retention scheduler or business redispatch.

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

Pass `supacloud.workflows` as the handler's `workflows` port. The existing dispatcher
routes reconcile steps to `run(claim)` and other steps to their registered handlers.
PGMQ/Workflow owns delivery, visibility, attempts and dead-letter state. Completion
requires confirmed business output and complete audit, not merely a successful
lookup call. Bound lookup duration and monitor failed/unknown operations.

Redaction keeps fingerprints and receipts: same-input explicit replay deduplicates;
different input conflicts; reference-only lookup returns `COMMAND_INPUT_EXPIRED`.
Never issue a new operation just because the old input expired.
Already confirmed/audited receipts can still acknowledge a delayed recovery step
after input redaction. Retention is a separate maintenance operation.

See [breaking changes, schema upgrade, release and rollback](../../docs/command-migration.md).
Run `bun run typecheck`, `bun run typecheck:test`, `bun test` and `bun run build`.
