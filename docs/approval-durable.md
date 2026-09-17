# Durable Approval Runtime

## Scope

`packages/approval/src/durable.ts` and the versioned `packages/approval/sql/` migrations
implement a new, private approval runtime. pg_durable is its only execution
engine. TypeBox supplies the versioned JSON-only definition contract; the
migration renderer embeds that exact contract for pg_jsonschema to enforce.
The existing XState entry point remains optional advisory tooling and is not
called by this runtime.

Supported: immutable published definitions, pinned definition versions,
sequential stages, all-of and any-of approval, rejection, requester cancellation,
deadlines, assigned-actor checks, maker/checker separation, optimistic versions,
idempotent command receipts and append-only-by-API audit events. Any-of means
the first accepted approval completes the stage; a rejection before completion
rejects the run. A completed stage cannot accept another decision.

The initial definition format deliberately supports ordered stages, not arbitrary
DAGs, SQL, JavaScript, URLs, expressions or dynamically supplied handler names.
Version 1 approver identities are published snapshots. Version 2 and 3 definitions
contain assignment rules resolved by a database-installed domain adapter when
each stage opens, with current eligibility rechecked on every new decision.
This is not an electronic-signature engine.

## Dynamic Assignments

Migration 005 adds the version 2 definition format. Version 1 definitions and
the rendered migration 001 retain their original contract and checksum.

```json
{
  "schemaVersion": 2,
  "steps": [
    {
      "key": "technical",
      "mode": "all",
      "assignment": { "resolver": "fa.qualified-reviewers", "scope": "laboratory-1" },
      "timeoutSeconds": 86400
    }
  ]
}
```

The application still calls the same start/decide APIs. An administrator must
first install a reviewed implementation of
`approval.resolve_assignment(tenant text, entity text, rule jsonb) RETURNS jsonb`.
The default implementation raises `APPROVAL_ASSIGNMENT_ADAPTER_REQUIRED`.
The resolver name is a domain policy key, not an executable function name.
Definitions cannot install adapters, invoke arbitrary handlers or supply SQL.

An adapter returns `{"actors":["reviewer-1"],"revision":"membership-revision-7"}`.
The shared TypeBox/pg_jsonschema contract requires 1-50 unique valid identities
and a nonempty revision of at most 256 characters. Unknown rules, missing scope
or entity, empty assignments and unavailable authoritative data must fail
closed. Do not silently fall back to administrators or the requester.

The adapter is invoked with approval-owner privileges and an empty search path.
Use fully qualified, reviewed queries and narrow grants; never grant the owner
broad access to application data. Tenant, entity visibility, organization scope
and professional qualifications must all be checked against authoritative
business records. The adapter must lock the eligibility records until the
calling transaction ends, including the parent policy/membership row needed
to serialize changes that add or remove candidates. Every writer of that
eligibility data must follow the same locking protocol. An unlocked read or
remote HTTP check does not establish atomic eligibility.

The engine preserves the rule, resolved identities and source revision in
immutable `approval.assignments` records and `assignment_resolved` audit events.
Each new decision resolves the same rule again, checks the deciding actor and
records `eligibility_verified`, including both revision identifiers. Accepted
decisions are not retroactively revoked when memberships change. Exact request
replay returns the original receipt without re-running eligibility checks.
Backend authentication and entity authorization are still required on replay.

Newly eligible people do not silently acquire existing tasks. No reassignment
API is included in this increment. A revoked assignee is blocked; the requester
can cancel and start a fresh instance where appropriate until an audited
reassignment operation is implemented. Both `all` and `any` retain their existing
voting semantics; these are not candidate-pool claim operations.

If resolution of the next stage fails, the entire transition, including the
last decision on the current stage, rolls back. Fix the domain assignment and
resubmit; do not assume that rejected transaction recorded an approval.
No partial tasks, eligibility audit events, receipts or wakeups are committed.

Acceptance scenarios covered by the targeted integration file:

- Given a rule with valid candidates, when a stage opens, then its immutable
  assignment snapshot is recorded and only those people receive tasks.
- Given a revoked assignee, when a new approval or rejection is submitted,
  then eligibility fails without changing the instance or recording a decision.
- Given changed membership for a future stage, when that stage opens, then it
  resolves the new membership rather than reusing the first-stage snapshot.
- Given an invalid assignment or a requester in the resolved candidates, when
  starting or advancing, then the transaction fails without partial progress.
- Given a committed decision, when the same request is retried after revocation,
  then the original receipt is returned without a duplicate decision.

This increment supplies the integration boundary, not an installed FA adapter.
Cross-database FA authorization cannot be made atomic by this local hook; a
separate consistency design is required before adopting that deployment shape.

## Business Version Binding

Migration 006 adds definition version 3: the version 2 shape plus a required
`subjectResolver` policy key, for example `fa.report`. Version 3 requires an
explicit business snapshot on both start and decide. Version 1/2 instances keep
their existing unbound semantics; adding a snapshot to those commands fails.
Historical rendered migrations 001 and 005 retain their checksums.

```ts
const businessSnapshot = {
  revision: 'report-revision-7',
  sha256: 'a'.repeat(64), // Example only; use the authoritative content digest.
};
await client.start({
  tenant, actor, requestId, definitionKey: 'report-review',
  definitionVersion: 1, entityId, businessSnapshot,
});
await client.decide({
  tenant, actor: reviewer, requestId: decisionRequestId, runId,
  expectedVersion: rowVersion, decision: 'approved', reason: '',
  businessSnapshot,
});
```

Install a reviewed database implementation of
`approval.resolve_subject(tenant text, entity text, resolver text) RETURNS jsonb`
before starting version 3 flows. Its default raises
`APPROVAL_SUBJECT_ADAPTER_REQUIRED`. It returns the authoritative
`{ "revision": "...", "sha256": "<64 lowercase hex characters>" }`.
The FA adapter owns canonicalization, digest calculation and inclusion of
relevant report content, attachments and other frozen review material.
A client-supplied digest alone is not evidence of the current business content.
This generic engine checks structure and equality; it does not calculate or
cryptographically attest a report digest.

The adapter must reject unknown policies, wrong tenant/entity and inaccessible
or missing reports. It must lock the authoritative document/version records
until the calling transaction commits. All content/version writers must follow
the same locking protocol, including child-table and attachment changes. The
consistent lock order is approval run, business subject, then eligibility
records; business operations combining these resources must use the same order
or retry transactions on deadlock. Cross-database reads do not establish this
atomic guarantee.

Start verifies the provided snapshot and records it immutably on the run.
Every new decision first matches the submitted snapshot to the pinned snapshot,
then rechecks the authoritative subject under lock. Either a revision change or
a digest change raises `APPROVAL_SUBJECT_CHANGED` and rolls back the transaction.
Missing or incorrect snapshots cannot bypass this through the old API overload.
Existing caller authentication, entity visibility and assignment checks remain
required. Exact replay returns the original receipt, even if the report has
since changed; it is not a new approval of that changed report.

Receipts, started/decision audit events and terminal outcome payloads carry
`businessSnapshot` for bound instances. The application client rejects a bound
command response whose snapshot is missing or different from its input.
Upgrade clients and outcome consumers before publishing version 3 definitions.
Consumers must compare the outcome snapshot against the business version in
the same transaction as applying the business effect. `ack_outcome` acknowledges
delivery only; it does not certify the current report or authorize release.
Content edits after approval do not retroactively rewrite the approval record:
FA must invalidate release eligibility and require a new review as appropriate.

Cancellation and timeout remain possible after content changes or adapter
failure, and their outcomes still identify the original reviewed version.
There is no automatic rebinding, automatic approval reuse or restart in this
increment. Explicit review rounds and FA report integration remain separate work.

Acceptance scenarios in the single targeted integration file:

- Given a stale initial snapshot, when starting, then no run is created.
- Given a bound pending run, when revision or digest changes, then a new decision
  fails without creating a ballot, receipt, wakeup or terminal outcome.
- Given a decision transaction holding the subject lock, when a concurrent edit
  occurs, then the edit waits until the decision commits.
- Given a committed decision and later content changes, when the exact request
  is replayed, then the original receipt and original snapshot are returned.
- Given changed or unavailable content, when cancellation or timeout occurs,
  then the instance ends and the outcome retains its original snapshot.

## Local Environment

Use the dedicated Compose project; it does not modify other local databases.
Set `APPROVAL_POSTGRES_PASSWORD` in the invoking environment, then run:

```sh
docker compose -f docker/approval/compose.yml up -d --build --wait
bun packages/approval/scripts/install-durable.ts
bun test packages/approval/tests/durable.test.ts
bun packages/approval/scripts/check-durable.ts
```

The test uses actual extensions and a real worker, and restarts only the dedicated
`supacloud-approval` Compose container to verify recovery. It refuses non-local
Docker endpoints. It creates unique test tenants and retains their evidence.
It does not skip when the database is absent.

The installer maintains a SHA-256 migration ledger under `approval_migrations`,
serializes installers with a session advisory lock, and commits each migration
and its ledger row atomically. Already-applied versions are skipped. Modified
history and an unsupported newer database version fail closed. Never edit an
applied migration; add a forward migration.

`bun packages/approval/scripts/install-durable.ts --render` emits the reviewed
psql installation script without connecting to Docker or a database. Use this
artifact with the target environment's approved migration runner; runtime code
must never install schemas on first request.

The pre-ledger local prototype requires one explicit `--adopt-baseline` after
reviewing that its schema is the known initial prototype. This is not an
automatic adoption path for an unknown production schema.

The default port is loopback-only `55438`; set `APPROVAL_POSTGRES_PORT` if occupied.
The image pins PostgreSQL 18.4, pg_durable 0.2.8 and pg_jsonschema 0.3.4.
Both extension downloads are SHA-256 verified. The image currently uses
linux/amd64; Apple Silicon uses Docker's emulation.

No credentials are written to repository files. Keep the chosen password in
your local secret manager if using TCP; administrator access for local tooling
uses `docker exec ... psql -U postgres -d postgres`.

## Self-host Environment

The self-host image always packages pg_durable 0.2.8 on amd64 and arm64.
Set `ENABLE_PG_DURABLE=true` at runtime when initializing the self-host profile
to enable preloading and initialize the worker in `POSTGRES_DB`.
pg_jsonschema is already installed by this profile.
pg_cron stays installed because other platform components use it; approval does
not depend on it or schedule any cron job.

Initialization scripts only run on a new volume. Existing volumes require a
reviewed administrator change: install the matching binary, add pg_durable to
the existing preload list without removing other entries, set its database,
worker role and local connection settings, restart PostgreSQL, create the
extension and apply the rendered approval migration. Never delete the volume
to activate an extension.

The worker connects as the submitting role. `supacloud_approval_owner` is a
non-superuser LOGIN role with no password set by this migration. The local
image uses Unix-socket authentication. Other environments must configure a
restricted, explicit authentication path for that role and the worker.
Do not enable remote trust authentication or superuser workflow submissions.

This installer targets the configured `pg_durable.database`; it is not an
automatic per-tenant-database rollout mechanism.

## Security and Domain Ownership

Only a trusted server identity receives membership in
`supacloud_approval_service`. That role can execute four fixed functions:
`approval.start`, `approval.decide`, `approval.cancel`, `approval.get_run`,
and cursor-paginated `approval.list_events`.
It cannot access private tables or call engine functions. Do not grant this
role to `anon`, `authenticated` or browser-facing Data API identities.

The server must derive tenant and actor from authenticated membership and
authorize entity visibility before calling. The service role is intentionally
trusted across tenants; a caller-supplied tenant string is not authentication.
Database functions additionally scope every lookup by tenant and verify task
assignment or requester identity. `supacloud_approval_publisher` can publish
immutable versions through `approval.publish`, with actor and request identity
recorded separately. It cannot approve requests or run maintenance.

`supacloud_approval_operator` can inspect aggregate operational health, run a
bounded maintenance pass, ensure the schedule is running, retry a failed
execution with an expected engine ID, and requeue dead-lettered outcomes.
Manual recovery requires a reason and writes an audit event.
`approval.recovery_queue(limit)` exposes bounded identifiers/error codes for
actionable failures without granting operators table access.
`approval.retry_wakeup(tenant, request_id, expected_engine, reason)` repairs an
exhausted notification with the same stale-engine fence.
`supacloud_approval_consumer` can only claim, acknowledge and reject delivery
leases for terminal outcomes. These are trusted server roles, not end-user roles.

Runtime audit/receipt/publication APIs are append-only, and SQL triggers also
block UPDATE, DELETE and TRUNCATE where applicable. Delivery payloads and
acknowledged outcomes cannot be rewritten. A database owner can deliberately
disable triggers, so this is not cryptographic tamper-proof storage; regulated
signature/evidence retention remains an application and infrastructure duty.

All SQL executed by the engine is generated by fixed database functions.
Untrusted definitions cannot contain executable SQL. User values use SQL
literal quoting inside fixed templates, or query parameters in the TS adapter.

Approval records are generic approval facts. FA report status, content checksums,
signature manifests, qualifications, current memberships and review-round reuse
remain FA domain responsibilities. Before actual FA adoption, call approval
commands and domain writes on the same database transaction/connection, with
FA authorization checks. Domain failures must roll back the approval command.
Do not infer a legally signed report from generic `approved` status.

## Transactions and Wakeups

Commands lock the instance and serialize request IDs. An exact replay returns
the original receipt; reusing an ID with different arguments fails. Versions
are decimal strings, not JavaScript bigint-to-number conversions.

`df.start(..., transaction_mode => 'caller')` joins the business transaction.
Approval decisions and notification intent commit together. A separate durable
delivery instance calls `df.signal` only after commit; its payload contains no
decision. Notification delivery can duplicate after a crash, so receivers
always reread approval tables and never treat a signal as authorization.

Each active stage owns one durable wait bounded by its deadline, rather than
polling continuously. Opening a new stage starts a new wait in the same
transaction. Notification intent targets the previous stage's engine ID.
Each wait carries a generation token: a duplicate activity or an old stage
cannot mutate the new stage. An early signal rereads the domain record and
starts a replacement wait for the original deadline, not a fresh full duration.
A missed signal only delays cleanup of the old execution until its timeout;
it cannot strand the next stage.

Deadlines are checked under the same row lock as decisions. Late decisions are
rejected even if the worker has not yet marked the run timed out. Decisions
committed before a deadline remain valid after delayed worker execution.
Timeout processing is eventually executed, not a real-time scheduling SLA;
worker outages can delay recording the terminal timeout.

## Operations and Remaining Adoption

Monitor engine failures and pending `approval.wakeups`, expired pending runs,
worker progress and database connections externally. A PostgreSQL healthcheck
alone does not prove that the execution worker is advancing.

The installer starts a singleton durable maintenance schedule. New schedules
run once per minute and isolate failed iterations. Each pass handles at most
50 approval runs and 50 notification records with row locks and SKIP LOCKED.
Failed/missing/completed-while-pending engines are replaced with a new wait
generation, preserving ballots, row versions and deadlines. Runtime recovery,
timeout failures and notification recovery are bounded to five attempts, with
backoff. Expired approvals have a separate recovery budget, so earlier runtime
failures do not prevent them from timing out. Poison records are isolated and
reported, not retried indefinitely.

`approval.operational_health()` reports the maintenance heartbeat, overdue
approvals, failed/exhausted recovery, undelivered wakeups, outcome backlog and
dead letters. Alert when heartbeat age exceeds three minutes, deadlines remain
overdue, retries are exhausted, or terminal outcome age exceeds the consumer's
delivery SLA. The local health script defaults to five minutes for outcome age.
Keep this monitor outside pg_durable: a stopped engine cannot reliably detect
its own failure. After repairing the infrastructure, an operator calls
`approval.ensure_maintenance()` if the schedule itself is terminal or absent.

Upgrade note: an already-running schedule retains its original graph. If
upgrading a schedule created before failure-isolated iterations, an administrator
must stop that schedule and call `approval.ensure_maintenance()` after commit.
Never run a second independent scheduler over the same instance.

Do not manually reset domain state to replay a failed workflow. Operator
`approval.retry_execution(tenant, run, expected_engine, reason)` fences stale
recovery requests and cannot restart a healthy non-expired execution.

## Terminal Outcome Delivery

Every terminal transition writes one immutable outcome in the same transaction.
`approvalOutcomeClient` exposes claim/ack/nack using a transaction-bound server
connection. SQL consumers can use `approval.claim_outcome(tenant, lease_seconds)`,
`approval.ack_outcome(tenant, run_id, lease_token)` and
`approval.nack_outcome(tenant, run_id, lease_token, error_code)`.

Delivery is at least once, not exactly once. Use `(tenant, run_id)` as the stable
consumer idempotency key. Commit local domain effects, the consumer idempotency
receipt and acknowledgement on the same connection/transaction. For external
effects, use a downstream idempotency key or a domain outbox; a lease alone
cannot guarantee exactly-once network side effects.

Lease duration is 1-600 seconds. Expired leases may be reclaimed; a stale token
cannot acknowledge a newer claim. Acknowledgement with the already-committed
token is replayable. Nack accepts bounded error codes only, not secret-bearing
exception text, and applies exponential backoff. Ten unsuccessful claims result
in a dead letter; operator requeue requires an audit reason. Consumers must keep
polling after an empty claim: it may have moved an exhausted item to dead letter.

No audit data or original request receipts are automatically deleted. This is
an explicit retention-first default, not a completed archival solution. Before
production, choose a retention policy and capacity budget; pruning receipts
changes the idempotency horizon and must not be enabled as generic cleanup.

## Release Acceptance

The single targeted integration file covers real-extension execution, database
restart, concurrency, rollback, timeout, recovery, schema parity, publication,
privilege separation, delivery fencing and migration integrity. Its bounded
12-instance concurrency exercise is a correctness test, not a capacity benchmark.
The same targeted file type-checks only the changed runtime, tooling and test
files through `tsconfig.durable.json`, without emitting artifacts or checking
unrelated packages. It also verifies that the external health probe returns a
failure status for the deliberately unconsumed synthetic outcomes. A post-test
health alert for those fixtures is expected, not a reason to suppress the alert.

Production release is still gated on:

- A real FA domain adapter with current membership/qualification, entity access,
  document snapshot and signing checks in the authoritative transaction.
- FA RPC acceptance for reject/review-round reuse/signature invariants. Generic
  workflow tests do not establish those application semantics.
- The selected deployment's authentication and least-privilege checks, backup
  restore drill, external alerts, consumer idempotency and fault recovery.
- Capacity measurements for the agreed active-instance count, command rate and
  timeout/delivery latency SLO, plus retention/storage budgets.
- Artifact packaging/build validation before release. The daily targeted
  integration and scoped type checks do not replace the application's release gates.

No FA HTTP endpoint, report-signing RPC, UI, remote environment or production
traffic is switched by this change. FA integration still requires a specific
domain adapter and real FA RPC acceptance tests. Return-to-specific-stage,
selective reuse of earlier approvals, working-day calendars and dynamic forms
are not implemented. The generic workbench described below is not an FA UI integration.

## Review Rounds And Task Lifecycle

Migration 007 adds a distinct terminal `returned` state. Returning for changes
requires an eligible assigned actor, a reason and the current row version.
Resubmission is requester-only and creates a new linked run with fresh tasks,
an explicit round and a current business snapshot. Old tasks and timers cannot
act on that round. The default is complete re-review, with no copied ballots.

Schema version 4 adds `claim` and integer `quorum` alongside `all` and `any`.
Task actions cover claim/release, controlled transfer, delegation/resolve and
additive approvals. Delegation resolution is not a vote. Adding an approver is
restricted to all-of stages and the default-deny `authorize_task_change` hook.
Original assignment snapshots remain evidence; changes have separate records.
All mutable eligibility decisions remain the domain adapter's responsibility.

## Graphs And Simulation

Schema version 5 uses a bounded acyclic node graph. Independent nodes execute
in parallel, dependencies form joins, and choices use scalar equality conditions
with exactly one default. No arbitrary SQL or expression evaluation is allowed.
The publisher rejects cycles, missing dependencies and ambiguous choice groups.
`planApprovalGraph` and `simulateApprovalDefinition` preview supplied facts and
candidate samples without starting runs or granting authority.

Graph facts are snapshotted through the domain hook. The host must bind those
facts to the same business revision/digest and transaction locking protocol.
Each active node opens a child approval instance; only the root produces a
business outcome. Child terminal events reliably wake root reconciliation.
Rejection, return, cancellation or timeout terminates the root and cancels
unfinished siblings. Percentage quorum uses the eligible population at node
opening, rounded up. There is no implicit timeout approval.

## Notifications

Publish notification policy before the definition's first run. Durable timers
make reminders and escalation notices deliverable; a separate consumer claims
and acknowledges them using fenced leases. Retries, dead letters, explicit
operator requeue and external health counters cover delivery failures.
Obsolete unsent notices are cancelled when the stage or run ends.

Migration 014 snapshots the notification policy (including its absence) when a
new graph root starts. Each subsequently opened child inherits that snapshot
and schedules notices against its own deadline. Previously started roots are
not backfilled, including their not-yet-opened nodes. Root cancellation cancels
pending child notices through the existing child terminal transition.
Escalation sends a notice; it does not silently replace approvers.

Operators can list bounded, run-scoped notice metadata and recover a dead
notice through the authenticated workbench. Recovery requires a reason, the
observed attempt count and an idempotency request ID. It locks the run before
the notice, rejects obsolete stages and elapsed deadlines, and audits the
authenticated actor. Notification payloads and lease tokens are not exposed
by the operator list endpoint.

## Execution Compatibility And Migration

Instances pin execution versions independently of definition versions. Frozen
core function fingerprints detect drift, and internal calls stay on their
versioned implementation. This guards core approval control flow; mutable domain
adapters and shared infrastructure are not deterministic replay isolation.

Applied migration checksums must never change. Migration 012 records a guarded
bootstrap correction to the graph implementation only before any version-3
instance exists. Future semantic changes require a new execution version and
in-flight compatibility tests, not edits to applied migration files.

Migration 013 provides operator-only, reasoned, default-deny instance migration.
`authorize_migration` must explicitly permit the target. Migration atomically
cancels the old root and starts the requested version of the same definition
for the same entity, recording immutable links and the real operator identity.
Failure rolls everything back; request replay returns the original receipt.
This is restart-style migration: progression and votes are not transferred.
Root cancellation has its normal outcome; consumers must handle both the
cancelled source and subsequent replacement outcome without interpreting the
old cancellation as a business approval.

## Embeddable Workbench

`createApprovalWorkbenchHandler` supplies a framework-neutral Request/Response
adapter for the assets under `packages/approval/web`. The host supplies:

- Authenticated tenant/actor, a session CSRF token and a server-only connection.
- Entity visibility checks, plus transaction-level authorization in commands.
- An explicit operator connection only for platform-authorized operators.
- Bundled browser JavaScript, HTML and CSS under the configured mount path.

The boundary rejects forged command fields, cross-origin writes, oversized
bodies and unauthorized entity access. Assets and responses are authenticated,
uncached and use a restrictive CSP. Service/operator database roles must never
be exposed as browser credentials. Host authorization must also cover review
history and audit contents for the permitted business entity.

Views include pending/done/started/delegated tasks, instance evidence, rounds,
graph children, recovery and controlled migration. Commands use row versions
and request IDs; failed submissions retain their reasons and retry identity.
The UI is a generic administrative surface, not a report editor or signing UI.

For local acceptance, run `bun packages/approval/scripts/preview-workbench.ts`
after installing the local migrations. It refuses nonlocal Docker endpoints,
creates a synthetic tenant, listens only on loopback and prints a one-use login
link. It uses the real engine, but its administrator-to-service SQL bridge is
local tooling only and must never be deployed as an application adapter.
The `--operator` flag additionally exposes local operator controls and seeds
synthetic failed deliveries for recovery acceptance. Two separate one-use
links are printed: reserve the user link and consume only the browser
verification link during automated acceptance.

## SupaCloud Delivery Boundary

SupaCloud provides the engine, versioned definitions and core execution,
notification timers/outboxes, service/consumer/operator interfaces, generic
workbench and fail-closed domain extension points. The targeted integration
file also verifies package JavaScript/declaration outputs and the browser
bundle. Local acceptance covers notification recovery with audit evidence.

FA supplies personnel/qualification and report/signature policy, including
whether prior approval evidence may be reused. Current generic resubmission
always creates a fresh review; the framework does not yet expose selective
reuse or resume-at-stage execution. Those are future engine extensions, not
capabilities an adapter can enable by returning a permissive authorization.
Likewise, migration currently restarts review rather than retaining progress.

Deployment-specific backup/restore, load/SLO acceptance and real notification
transport remain release gates. A local build or synthetic recovery does not
prove those properties of the target deployment.

Rollback: stop callers first, revoke the service-role membership, and retain
the extension and private records until running instances have been reconciled.
Do not drop either extension or the approval schema while instances are active.
