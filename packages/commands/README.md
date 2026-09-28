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

Both `createExecutionPolicy` and `createCommandRecoveryHandler` accept an optional
`observer`. Exported `ExecutionPolicyEvent` and `CommandRecoveryEvent` report
attempts, fixed decisions and recovery/settlement stages, never input, output or
raw exception data. Observers are best-effort, not awaited, and cannot turn their
own failures into command retries. A successful recovery lookup is not a
successful acknowledgement; check the separate `complete` stage.
See [composition and recovery](../../docs/framework-composition.md).

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

### Definitive Remote Rejection

`createExternalCommand` accepts an optional `rejection` policy alongside the
existing success `audit`. This is a durable outcome, not just an HTTP error
mapping. Configure it only when a downstream adapter can prove that the specific
dispatch was rejected before any business effect:

```ts
rejection: {
  isDefinitiveWriteFailure: (error) =>
    error instanceof ProviderRefusedBeforeEffect,
  audit: {
    event: "webhook.update.rejected",
    details: (input) => ({ target: input.id }),
  },
},
```

`ProviderRefusedBeforeEffect` represents an application-owned, trusted adapter
error. Do not classify an arbitrary HTTP 401/403/409 as definitive: an upstream
may already have applied the write before a later audit or response failed.
Network failures, timeouts and classifier exceptions still use read-only
reconciliation. An authoritative match can confirm the operation; otherwise its
outcome stays unknown. There is no automatic redispatch.

The store must support `session.reject`; opt-in without that capability fails
before inserting an intent or sending. The rejection audit and
`{ status: "rejected", audit: "complete" }` receipt commit atomically. No success
`result` is present. A failed rejection transaction reports
`COMMAND_OUTCOME_UNKNOWN`, never a definitive denial. The optional rejection
audit `write(transaction, input)` must use that same local transaction, not call
a remote audit service.

Repeated execution, lookup and recovery preserve the rejected terminal receipt
and still enforce authorization and operation identity. A `rejected` receipt is
distinct from a preflight `COMMAND_REJECTED` exception: it is durable evidence for
that operation, not permission to generate a new key and blindly retry.

## Recovery

Interactive methods reauthorize the original actor. Worker `recover` requires
independent `authorizeRecovery(principal, reference, transaction)` and keeps
the original receipt identity. No recovery policy means denial. Neither method
assumes that a cancelled or failed request rolled back.

Pass `supacloud.workflows` as the handler's `workflows` port. The existing dispatcher
routes reconcile steps to `run(claim)` and other steps to their registered handlers.
PGMQ/Workflow owns delivery, visibility, attempts and dead-letter state. Completion
requires a confirmed or rejected terminal receipt and complete audit, not merely
a successful lookup call. A completed recovery workflow retains `rejected` in its
output and does not imply business success. Bound lookup duration and monitor
failed/unknown operations.

Redaction keeps fingerprints and receipts: same-input explicit replay deduplicates;
different input conflicts; reference-only lookup returns `COMMAND_INPUT_EXPIRED`.
Never issue a new operation just because the old input expired.
Already confirmed or rejected, audited receipts can still acknowledge a delayed recovery step
after input redaction. Retention is a separate maintenance operation.

See [breaking changes, schema upgrade, release and rollback](../../docs/command-migration.md).
Run `bun run typecheck`, `bun run typecheck:test`, `bun test` and `bun run build`.
