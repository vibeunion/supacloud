# Command / Workflow Convergence

SupaCloud owns one delivery runtime: existing Workflows on PGMQ. Commands own
execution safety, not an independent polling queue. This change intentionally
replaces the unreleased recovery scanner API.

## Ownership

| Layer | Responsibility |
| --- | --- |
| contracts | Shared runtime-validated command status and identity |
| commands | Transactional execution, one external send, safe per-delivery recovery |
| db | Execution receipts, same-connection transactions and Workflow binding |
| existing Workflow / PGMQ | Delivery, visibility, attempts, retry budgets and dead letters |
| SDK commands | One submit/get status surface for submissions and executions |

Submission and execution records are different facts, not independent command
authorities. A submission is accepted work, never proof of its side effect.
An execution receipt is confirmed only after domain reconciliation/transaction.
When a submission is bound to an executor, its existing UUID is also the execution
dispatch key and Workflow run ID. No second command or recovery workflow is created.
Direct executions retain their scoped idempotency key and expose their generated
global dispatch ID as `commandId`. Both identities resolve through `commands.get`.

## Worker Wiring

The existing trusted dispatcher calls `supacloud.workflows.claim`. It routes an
`execute` step to the registered business command and a `reconcile` step to the
recovery handler. Unknown workflow names/steps must go through the dispatcher's
normal registration/error policy, not be discarded by a command-specific consumer.

For a submitted execution:

```ts
const store = createPostgresCommandStore(database, {
  submission: {
    commandId: claim.runId,
    stepId: claim.stepId,
    messageId: claim.messageId,
    attempt: claim.attempt,
    workerId: claim.workerId,
  },
});
```

The dispatcher supplies the verified original identity, registered command and
unchanged submitted payload to the executor with `operationId = claim.runId`.
The adapter verifies the actual Workflow attempt, tenant, actor, command name and
payload fingerprint in the transaction. Do not call Workflow complete/advance
again after this bound executor: it already does so atomically.

Transactional commands commit business, receipt, audit and Workflow completion
together. External commands commit intent and advance the same Workflow from
execute to reconcile before the single remote send. A lost commit response cannot
justify sending again.

The recovery registration uses a regular unbound command store:

```ts
const recovery = createCommandRecoveryHandler({
  workflows: supacloud.workflows,
  principal: { subject: workerId },
  tenantId,
  commands: registeredRecoverableCommands,
  authorize: authorizeWorker,
  retryDelaySeconds: 60,
});
await recovery.run(claim);
```

This handles `supacloud.command.reconcile` (direct execution) or `command.<name>`
at step `reconcile` (submitted execution). The worker identity must match the
claim's workerId. Per-command `authorizeRecovery` remains mandatory. The handler
never sends the business request, even when Workflow retries it.

The handler's `retry` result means it requested Workflow retry, not that another
attempt is guaranteed. Read Workflow status to distinguish queued retry from
retry-budget exhaustion.

Initial reconciliation budgets are 20 attempts. Tune this policy through the
application's reviewed database migration and worker retry-delay configuration,
not by adding another retry loop. Exhaustion/failure remains visible in Workflow;
it does not change an unknown business receipt into a rejected/rolled-back one.
Monitoring must include failed/dead-letter Workflow steps and unresolved execution
receipts. The host still owns dispatcher deployment, lookup timeouts and alerting.

## Migration

1. Stop the old recovery scanner and drain/stop writers during the coordinated
   schema/SDK change. Take a normal database backup.
2. Install PGMQ and the existing `workflows-public` module, then the updated
   `commands-public` module using the project's normal migration mechanism.
   Native schema and Lite embedded SQL are generated from the same modules.
3. For a new execution store install `COMMAND_PERSISTENCE_SQL`; for the unreleased
   v1/v2 prototype install `COMMAND_PERSISTENCE_UPGRADE_SQL` in one transaction.
   It preserves operation keys, dispatch UUIDs, inputs and fingerprints; enqueues
   unresolved external operations once; drops old scanner lease/backoff columns.
   Already existing Workflow runs, including failed runs, are not restarted.
4. Old scanner attempt counts/timestamps are not Workflow attempts. Cutover resets
   scheduling for newly backfilled operations to the new 20-attempt budget; retain
   pre-cutover operational history in the backup/audit system.
5. Replace `createCommandRecoveryJob`, `store.claim` and `store.release` with the
   existing dispatcher plus `createCommandRecoveryHandler.run(claim)`.
   Move `redactCompleted` to the existing maintenance schedule.
6. Upgrade SDK consumers to the discriminated `CommandStatus` result:
   `kind: submission` has execution=null; `kind: execution` carries the receipt.
   Use `workflows.get(commandId)` for full workflow details. Do not read old
   top-level idempotent/target/full-workflow fields from commands.get/submit.
7. New submissions intended for a durable executor must carry verified tenantId
   and actorId. Legacy submissions lacking either remain queryable and can use
   their old worker, but cannot be bound by guessing missing identities. Use a
   reviewed data migration with authoritative identity evidence before binding.
   Canonical input must equal the recorded submission payload; do not silently
   normalize an existing submission into different command input.
8. Restart the existing dispatcher with registered execute/reconcile handlers.
   Verify duplicate delivery, lost responses, tenant isolation, exhausted retries
   and the one-query status surface before enabling production writes.

Only the service-role RPC exposes the unified status; it is not a browser-facing
authorization API. A trusted host must enforce tenant/user access before proxying
it. Database runtime roles also need narrowly scoped Workflow/private-function
permissions for enqueue/binding in addition to business and receipt table grants.
Private schema membership alone is not authorization.

Old SQL submission payloads and Workflow inputs are retained by their existing
runtime policy. Encrypting execution input does not retroactively encrypt legacy
submission payloads. Audit that data separately and do not copy sensitive inputs
into new reconciliation messages.

Rollback requires a coordinated worker/SDK/schema rollback from a verified backup
or a forward-fix migration. Do not restart the old scanner on the new schema and
never regenerate command IDs to make failed operations disappear.

```gherkin
Scenario: Durable external intent
  Given a new external operation
  When its intent commits
  Then its recovery workflow commits in the same database transaction
  And enqueue failure prevents the external send

Scenario: Unknown remote result
  Given an external request whose result is unknown
  When Workflow redelivers its recovery step
  Then only reconciliation and audit completion may run
  And the business request is never sent again

Scenario: One status lookup
  Given a legacy queued submission or a direct execution
  When the SDK queries its command identity
  Then the result explicitly distinguishes submission from execution
  And workflow completion is never treated as proof of a business effect

Scenario: Concurrent recovery
  Given a stale worker and a newer Workflow attempt
  When both attempt to acknowledge the task
  Then Workflow rejects the stale acknowledgement
  And command transaction locks still prevent duplicate audit writes

Scenario: Prototype migration
  Given pending receipts from the unreleased scanner implementation
  When the migration runs with old workers stopped
  Then each receipt receives one recovery workflow without changing its identity
  And completed receipts are not enqueued
```
