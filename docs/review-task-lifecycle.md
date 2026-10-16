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

- Given a committed upload registration, when its original request is replayed
  while Storage is unavailable, then current authorization and receipt validation
  precede returning the stored result without downloads or Artifact registration.
- Given an upload binding whose commit acknowledgement was lost, when the same
  key/input is reconciled, then one attachment binding, receipt and audit remain.
- Given denied access, changed input, a corrupt receipt or a receipt read failure,
  when registration is replayed, then it fails closed before external calls.
- Given a committed approval whose HTTP response was lost, when the reference
  client is recreated with its pending marker and reconciles, then it uses only
  the authenticated receipt GET route, confirms the original operation and
  clears the marker without another approval or audit.
- Given a missing receipt, revoked access or a mismatched original version,
  when that client reconciles, then it retains the pending operation and cannot
  issue another approval. Those outcomes do not prove the original write failed.
- Given receipt operation contracts, when server and browser types compile,
  then they derive from the same maintained schema. The server decodes the
  numeric operation before calling the receipt port.
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

### Reference Client Recovery

`ReviewOperation` and `ReviewReceipt` now derive from `ReceiptOperation` and
`ReceiptResult` in `src/review/contracts.ts`. Server receipt ports and browser
operation types use those exports. Browser imports are type-only: no Elysia
runtime is added to the client bundle. Keep the maintained contracts available
to the browser typecheck; do not copy a second interface into the client.
The persisted-marker decoder remains a separate storage-boundary check.

The native acceptance compiles the generated client and the maintained browser
transport against these contracts. It deliberately changes an operation field
type and verifies that stale browser code fails to typecheck. It also exercises
the reference client's lost-response recovery through real authenticated route
handlers and PostgreSQL receipts. This is client-state reconstruction, not a
real-browser refresh test; the list refresh is stubbed and is not PostgREST
acceptance.

No SQL migration or stored-marker format changes are introduced. Existing custom
receipt ports retain their method signatures. The receipt service now rejects
invalid operation kinds, identifiers, extra fields and out-of-range numeric
versions before invoking a port. Continue retaining unresolved markers on
missing, denied or conflicting lookups; none proves that the write rolled back.

### Upload Registration Replay

The upload host now checks the existing transactional `review.attach` receipt
before downloading the object or calling Artifact registration. The lookup
reauthorizes current project/tenant, ownership, membership, storage identity and
revision, checks the original key/input fingerprint, and validates the stored
result against `UploadResult`. A confirmed receipt returns that original result
even if Storage is unavailable. It is not a new integrity check of the current
object. A recreated host uses the same durable record, not an in-memory cache.

Denied access, changed input, invalid receipts and database errors stop the
request before those external calls. Only a successful lookup with no receipt
continues through the existing registration path. That path still rechecks
authorization before downloading and inside the binding transaction.

This is an additive host behavior change with no new SQL migration, request
shape or idempotency-key format. Adopt the updated generated
`src/host/review-uploads.ts`; keep existing receipts and audit history.
The reference browser continues using read-only GET reconciliation rather than
automatically resending registration POSTs.

This does not make Storage, Artifact registration and PostgreSQL atomic. Without
a committed receipt, an earlier external effect may still exist; concurrent
first requests may still reach the external service. Do not infer safe deletion,
automatic re-upload or exactly-once external execution from this change.
Unbound objects and incomplete external registration need separate reconciliation.

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
