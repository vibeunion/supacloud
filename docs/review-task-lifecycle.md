# Review Task Lifecycle

The command starter now includes the customer-facing task status and explicit
failure-recovery path. It uses the existing verified identity, PostgreSQL
Command store and Workflow runtime. It does not expose Workflow service-role
RPCs to browser clients.

## Customer Contract

`GET /reviews/:id/attachment-task` returns:

- `reviewId`, current review `version`, `artifactId` and current `runId`;
- `state`: `not_submitted`, `queued`, `running`, `completed`, `failed` or `cancelled`;
- `attempts`, `maxAttempts`, `canRetry`, and the validated result on completion.

The endpoint rechecks project/tenant binding, enabled membership, approval
permission and current ownership. Nonexistent and foreign reviews have the same
denial behavior. It never returns queue message IDs, Worker identity, raw
Workflow inputs, internal errors, service credentials or Storage paths.
An incomplete/corrupt Workflow snapshot fails; it is not reported as an idle job.

`POST /reviews/:id/attachment-task/retry` accepts:

```json
{
  "expectedVersion": 2,
  "expectedRunId": "11111111-1111-4111-8111-111111111111",
  "recoveryId": "22222222-2222-4222-8222-222222222222"
}
```

Only a currently bound **failed** run may be retried. Active, completed,
cancelled, unsubmitted, changed-revision or mismatched runs cannot be restarted
through this operation. Each explicit recovery creates a new run with three
automatic attempts and an immutable predecessor link. The old run and attempt
history are not rewritten. Repeated manual recovery is an explicit business
decision, not an infinite automatic retry policy.

The new run, recovery lineage, idempotency receipt and audit are committed in
one database transaction. Concurrent different keys cannot fork one predecessor.
The same `recoveryId` and body replay the submission receipt only after fresh
authorization. A changed body conflicts. After an uncertain response, retain
and retry the same key/body, then read current status. Do not issue a new key
just because a response was lost. The receipt's `queued` state describes the
original submission, not the latest runtime state.

The generated client and OpenAPI are derived from `task-contracts.ts` and the
route contracts. SQL result decoders are explicitly checked against the
Drizzle-inferred row projections; incompatible field changes fail in the
maintained host code, not a manually edited generated type.
Use the existing `createAuthenticatedFetch` integration to
resolve the current session token per call; do not introduce another session
store. The generated client exposes `reviewTasks.status` and `reviewTasks.retry`.

## Worker Recovery

The Worker checks that a claim belongs to the latest bound execution. Automatic
retry delays, lease expiry, fencing and attempt exhaustion remain owned by
Workflow. On redelivery, the attachment store reauthorizes and validates a
committed result before performing another Storage download.

An unknown claim or unconfirmed settlement still halts the Worker. Inspect
canonical status and fix the infrastructure/ownership problem before restarting
it. The customer retry endpoint does not restart processes or manipulate active
leases. A status query is a snapshot, not a promise that the next operation will
see unchanged permissions or state.

## Migration

1. Keep migrations 001-004 unchanged. Review and apply new operator migration
   `005-review-task-recovery.sql` after the platform Workflow runtime and 004.
2. The new append-only `starter_attachment_retries` table is readable by the
   HTTP/Worker roles and insertable only by the HTTP role. The HTTP role also
   gains the existing private Workflow snapshot function. Browser/PUBLIC table
   privileges are explicitly revoked, including grants inherited from default
   privileges. No backend UPDATE/DELETE rights or new public security-definer
   function are added.
3. Adopt `task-contracts.ts`, `tasks.ts`, `host/review-tasks.ts`, the updated
   feature registration, PostgreSQL/delivery host and Worker ownership check.
   Update `db/schema.ts`, `db/modules.ts` and the delivery migration inventory.
4. Regenerate database contracts and compiled client/OpenAPI from maintained
   source. Never manually synchronize generated types. Compile and run the
   focused local acceptance before starting the new HTTP or Worker version.
5. Custom hosts pass `tasks` to `createReviewPostgresAdapters`. The shipped
   delivery host configures it with `REVIEW_ATTACHMENTS=enabled`; absent task
   infrastructure fails explicitly, without an in-memory production fallback.

Old binaries can remain running while the additive migration is applied. Once a
new recovery run exists, do not roll back to the old Worker: it recognizes only
the original run binding. Drain/stop processing and reconcile active lineage
before any application rollback. Do not delete recovery history or applied
migrations as a rollback technique.

Upload types and decoders now derive from the existing upload contracts too.
Input no longer silently accepts extra fields, and versions are bounded to the
PostgreSQL integer range. Existing clients should send only the documented
fields. No identity mapping or Storage policy is changed by this increment.

## Acceptance

- Given a registered attachment, when its owner approves, then approval,
  receipt/audit and Workflow submission commit together and status becomes queued.
- Given a failed run, when its authorized owner requests recovery, then a linked
  new execution is created once; conflicting requests cannot fork the predecessor.
- Given a lost commit response or audit failure, when the same request is
  reconciled, then the durable outcome is either a single committed recovery or
  a complete rollback, never an orphaned recovery execution.
- Given missing/expired credentials, another owner or revoked permission, when
  status or replay is requested, then access is denied before returning data.
- Given the source contracts, when the starter compiles, then typed client,
  validators and OpenAPI agree; stale or missing adaptations fail locally.

Run the single targeted file from `packages/elysia`, after building the local
runtime/compiler/SDK and their dependencies:

```sh
SUPACLOUD_STARTER_POSTGRES_BIN=/opt/homebrew/bin \
SUPACLOUD_REQUIRE_RUNTIME_SAFETY=1 \
bun --no-env-file test src/starter-task-lifecycle.test.ts --timeout 60000
```

Use the appropriate local PostgreSQL binary directory. Tests create a disposable
loopback cluster, apply the actual migrations, compile the actual starter, sign
local test JWTs, and exercise the generated routes/client/Worker. Workflow RPCs
execute real canonical SQL under the service role; queue storage uses Lite SQL
compatibility. Artifact/Storage HTTP responses are fixtures.

This proves the local reference integration, not native pgmq, a real SupAuth
tenant, real Storage, published package availability, remote deployment, or
xigu-fa adoption. Those are separate acceptance records, not implied by a PR.

## Complete Reference Paths

| Path | Maintained source | Verification boundary |
| --- | --- | --- |
| Paginated queries | `list-reviews.ts`, Drizzle row projection and existing RLS | See [query acceptance](starter-review-query.md); this increment does not change PostgREST |
| Business writes | `createTransactionalCommandGovernance`, approval contracts and PostgreSQL host | See [transaction defaults](transactional-command-defaults.md); approval and enqueue are also exercised here |
| Background work | Job, Worker, task contracts and recovery host | This file's generated-client/HTTP/PostgreSQL/Worker acceptance |
| Result recovery | Job output schema and durable result adapter | See [result recovery](attachment-result-recovery.md); explicit recovery also reuses the result here |

For customer adoption, keep xigu-fa's business tables, approval rules and
existing migrations authoritative. Map one real approval action into the
Command adapter rather than copying this reference's review tables and policy.
Acceptance requires demonstrating that its handler contains the business rule
while shared infrastructure owns identity, transaction, receipt and audit.
This repository change alone cannot establish that customer-level outcome.
