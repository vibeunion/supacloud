# SupaCloud Approval

## Durable Approval Runtime

The new `@supacloud/approval/durable` entry point uses pg_durable for durable
execution and pg_jsonschema for database-side structural validation. It does
not use XState as an executor. See [the runtime guide](../../docs/approval-durable.md)
for installation, supported behavior, security boundaries and remaining adoption work.

## Optional Advisory Models

The original entry point provides experimental, code-defined models built on XState. It
calculates **advisory state transitions** and compares them with normalized
domain command outcomes. It does not execute approvals.

The package is private until the API and a real consuming application's
shadow results have been reviewed. No publishing or release automation is
enabled.

## Ownership

| Owner | Responsibility |
| --- | --- |
| Approval model | Versioned graph, named synchronous guards, pure transition prediction |
| Consuming application | Identity, permissions, submission snapshots, signatures, review rounds |
| PostgreSQL domain RPC | Final authorization, locks, idempotency, state, receipts and audit |
| Existing outbox and Durable Workflows | Notification and other asynchronous side effects |

## SupAuth integration

The durable approval package does not depend on SupAuth, Elysia or any remote
authorization service. A host may use `createApprovalIdentityFromSupAuth` after
`createSupAuthRequestContext` has verified the token and resolved current,
application-local access:

```ts
import {
  createApprovalIdentityFromSupAuth,
  durableApprovalActor,
} from '@supacloud/approval/durable';

const identity = createApprovalIdentityFromSupAuth(requestContext, {
  applicationId: 'xigu-fa',
  actorId: membership.id,
  membershipId: membership.id,
});
const { tenant, actor } = durableApprovalActor(identity);
await approvals.start({ tenant, actor, requestId, definitionKey, definitionVersion, entityId });
```

`issuer`, `subject` and `clientId` remain available on the identity for the
application's audit record. Only the resolver-derived `tenant` and `actor` are
passed to the generic approval SQL API. Memberships, qualifications, object
permissions and workflow decisions remain authoritative in the application
database; SupAuth remains an optional identity integration, not a workflow
database or remote policy decision point.

In this advisory entry point there is no instance table, actor process, timer, queue, SQL executor, HTTP
client, or second business ledger here. Guards are trusted application code,
not expressions uploaded by an administrator. They must be synchronous and
side-effect-free. Do not use guard closures to fetch data or mutate records.

## Usage

```ts
import { createApprovalModel } from '@supacloud/approval';

type State = 'pending' | 'approved';
type Event = 'approve';
type Facts = { eligible: boolean };

const model = createApprovalModel<State, Event, Facts>({
  key: 'purchase.approval',
  version: '1',
  initial: 'pending',
  states: ['pending', 'approved'],
  terminal: ['approved'],
  transitions: [
    { from: 'pending', event: 'approve', to: 'approved', guard: 'eligible' },
  ],
}, {
  eligible: facts => facts.eligible
    ? { allowed: true }
    : { allowed: false, reason: 'reviewer_not_eligible' },
});

const prediction = model.evaluate({
  snapshot: {
    definitionKey: 'purchase.approval',
    definitionVersion: '1',
    tenantId: 'tenant-1',
    entityId: 'purchase-1',
    state: 'pending',
    rowVersion: 3,
  },
  expectedRowVersion: 3,
  requestId: 'original-domain-command-request-id',
  actorId: 'authenticated-actor-id',
  event: 'approve',
  context: { eligible: true },
});
```

`proposal` does not grant permission or mean that a command committed. It
contains the unchanged input snapshot and a proposed next state, not an
invented next row version. Pass the original command through the application's
existing RPC, regardless of the shadow prediction. Do not gate the live RPC on
this experimental model.

Definitions and guard registries are copied at construction. Published model
versions must not be edited in place. The caller selects the matching model
for the domain record's pinned version. Every state must be reachable and have
a structural path to a terminal state. Multiple transitions for one event are
supported only when exactly one guard accepts; overlapping branches fail
closed, rather than silently preferring the first branch.

This is a typed code API, not a validator for untrusted designer JSON.

## Comparing domain outcomes

Use `compareApprovalOutcome(prediction, observation)` after the application has
validated its existing command receipt and normalized its status:

- Bind the outcome to the original request ID, event, tenant, entity and model
  version. Read versions from the actual receipt, never increment them locally.
- `committed` requires a matching predicted state and an advanced row version.
- `rejected` requires an authoritative rejection and unchanged domain state.
- Network failures and unavailable receipts are `unknown`, not `rejected`.
- Idempotent replays are inconclusive: compare the original captured request
  and result separately, not a new projection of the already-advanced entity.
- If another writer has changed the entity, do not substitute a later database
  read for the command-specific receipt.

A `match` compares acceptance and state only. It does not certify signatures,
audit contents, field changes, concurrent correctness, or authorization.
Record aggregate mismatch reasons rather than sensitive document contents.
The comparison never retries or changes a business command.

## xigu-fa reference models

`examples/fa-models.ts` contains source-only reference adapters; these are not
exported as generic SupaCloud domain rules and are not wired into FA routes.
The examples consume server-derived facts and bind them to the actor, tenant,
entity, event and row version. They do not replace FA's ReBAC or RPC checks.

| Model | Covered behavior |
| --- | --- |
| Intake order | Frozen submission, manual decision, automatic system decision with policy version, rejection back to `submitted` |
| Formal report | Technical review, quality review, independent authorized signing, reasoned return, retained technical approval on quality resubmission |

The report projection uses `review_stage`, not the case's overall `status`.
Its `signing` state is separate from `internal_quality`: quality approval is
not a signature. An administrator without `authorized_signer` cannot sign, and
the current quality reviewer cannot sign even when also an administrator.
Snapshot validity, current-round approvals and signer readiness must be
resolved by the application's authoritative policy code.

Source contracts checked in the adjacent xigu-fa repository:

- `supacloud/fa/app/features/v2-management/intake-approval.service.ts`
- `supacloud/fa/app/features/workflow/workflow.service.ts`
- `supacloud/fa/migrations/20260818110000_create_intake_order_auto_approval.sql`
- `supacloud/fa/migrations/20260817170000_quality_return_preserves_technical_approval.sql`
- `supacloud/fa/migrations/20260911140000_separate_authorized_report_sign.sql`
- `supacloud/fa/migrations/20260912235700_freeze_authorized_report_signer.sql`
- `docs/adr/ADR-003-workflow-definition-reservation-boundary.md`

These files informed synthetic local fixtures. The tests do **not** execute FA
RPCs, prove parity with the complete migration history, or validate a deployed
environment. Automatic inline completion, historical recovery states, all
admin exceptions, analysis-plan policies and subsequent report delivery are
outside these reference graphs.

FA's dormant designer definitions remain dormant. Activating them requires a
separate versioned execution contract and authorization review.

## Acceptance cases

```gherkin
Scenario: Frozen submission changes
  Given the server reports a changed submission snapshot
  When approval is predicted
  Then the model blocks the transition without changing domain data

Scenario: Quality rework preserves technical approval
  Given a returned report retains its latest approved technical review
  When the report is resubmitted
  Then the next proposed stage is quality review

Scenario: Quality review is not signing
  Given quality review is approved
  When an administrator without authorized signer qualification attempts signing
  Then the model blocks signing

Scenario: Definition or row version changes
  Given an input version differs from the selected model or expected row version
  When an event is evaluated
  Then no transition is proposed

Scenario: Command response is lost
  Given the actual RPC outcome is unknown
  When it is compared with the prediction
  Then the comparison is inconclusive and does not retry the command
```

## Local development

From this package directory:

```sh
bun install --frozen-lockfile
bun test tests/approval.test.ts
bun run build
```

Only the package's single targeted test file is required for this stage.
Before production adoption, capture command-specific FA RPC outcomes in a
separately authorized consumer change and run shadow comparison without
changing the existing approval decision path.
