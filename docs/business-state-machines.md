# Application Business State Machines

SupaCloud Durable Workflows owns execution mechanics such as leases, retries,
checkpoints, and cancellation. Application tables remain authoritative for
Maker-Checker, report rework, ticket, signing, and delivery states.

Use the reference files together:

- [`examples/maker-checker-state-machine.sql`](./examples/maker-checker-state-machine.sql)
  is an application migration template.
- [`examples/maker-checker-machine.ts`](./examples/maker-checker-machine.ts)
  is an XState projection for frontend and Edge Function code.
- [`examples/maker-checker-workflow-bridge.sql`](./examples/maker-checker-workflow-bridge.sql)
  is an optional transactional outbox and service-role dispatch bridge to
  SupaCloud Durable Workflows and PGMQ.
- [`examples/maker-checker-workflow-dispatcher.ts`](./examples/maker-checker-workflow-dispatcher.ts)
  is the corresponding trusted Worker or Scheduled Function loop.

The TypeScript file belongs in the consuming application, which owns and pins
its XState v5 dependency. SupaCloud core does not import or install XState.

## Required boundary

The browser must not update a business `status` column directly. It sends an
event to a database RPC with the entity ID, expected row version, reason, and an
idempotency key. The RPC locks the row and atomically validates the transition,
actor role, Maker-Checker separation, frozen payload checksum, and replay
identity before updating the entity and appending an audit event.

The reference freezes both the submitted JSON payload and its checksum. The
Checker approval path compares both values against the live payload, avoiding
approval of content that changed after submission and avoiding reliance on a
checksum alone.

## Transactional side effects

Business state and asynchronous intent must not be committed independently.
The optional workflow bridge uses an `AFTER INSERT` trigger on the immutable
transition event. For approval and completion events, it appends a private
outbox row in the same PostgreSQL transaction.

A trusted service-role dispatcher claims outbox rows with a bounded lease,
starts Durable Workflows with the stored fixed `runId`, then marks the dispatch
complete. Durable Workflows creates its run, first step, lifecycle event, and
private PGMQ message atomically. If the dispatcher crashes after workflow start
but before acknowledgement, retrying the same `runId` is idempotent.

The workflow input contains only the document ID, transition event ID, and entity
version. Workers read the authoritative document after claiming the step; do
not copy mutable or sensitive business payloads into workflow input. A worker
must never write `review_documents.status` directly. It may call another
domain RPC after an external effect succeeds.

The workflow service can be temporarily unavailable without losing or rolling
back an accepted approval; the outbox remains pending. Exhausted or explicitly
terminal dispatches are dead-lettered for operator review. Do not use a
best-effort Edge Function call from a trigger or client.

XState improves shared vocabulary and UI behavior, but it is not an
authorization boundary. A stale client, compromised browser, concurrent actor,
or offline replay can bypass client guards, so PostgreSQL must repeat every
decision.

## Adapting the migration

1. Rename the example tables and states to match the domain.
2. Replace `review_document_members` with the application's authoritative RBAC
   or ReBAC lookup. Never trust a role supplied in the request body.
3. Keep entity creation and membership assignment in a separate controlled
   intake RPC.
4. Preserve `row_version`, the per-entity idempotency uniqueness constraint,
   the append-only event fence, and the direct-transition fence.
5. Add every new event to both the SQL transition matrix and the XState
   projection. The SQL matrix remains authoritative.
6. Pin active records to a machine version when a domain must support multiple
   state graph versions at once.

For report rework, create a linked new report/case version rather than moving a
delivered report back to drafting. The prior version becomes superseded only
after the replacement passes review and signing.

## Verification matrix

At minimum, application tests must cover:

- every allowed `(state, event, role)` transition;
- every state/event combination that must fail;
- Maker and Checker identity equality;
- stale `expectedVersion`;
- identical and conflicting idempotency replay;
- payload changes after submission;
- direct status updates and audit event mutation;
- RLS visibility for members and non-members.

Use Durable Workflows only for side effects derived from an accepted domain
transition, for example to render a report, notify a customer, archive an
artifact, or retry an external integration. Use the transactional outbox above
when workflow availability must not block the business transition, and never
let a workflow become the authoritative business state.
