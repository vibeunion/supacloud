# Execution Engine Policy

## Supported Selection

Use one execution owner for each operation. Do not wrap one engine's execution
in another engine's retry/lease loop or create a new generic scheduler.

| Requirement | Default or explicit integration | Authority |
| --- | --- | --- |
| Local atomic business change | Existing transactional Command and PostgreSQL store | Domain state, receipt and audit in the same transaction |
| External side effect with unknown outcome | Existing external Command and receipt recovery | Durable intent and read-only reconciliation; never automatic redispatch |
| Linear durable task or Command recovery | Existing SupaCloud Workflow on PGMQ | Workflow owns leases/checkpoints; domain tables own business state |
| Actual DAG/fan-out requirement | Opt-in pgflow via the existing Worker integration | pgflow owns step scheduling/retry, not another platform queue loop |
| Durable approval-specific execution | Opt-in approval package using pg_durable | Application owns membership, object policy, approval decision and signing |
| Advisory UI state | Selected UI framework or existing optional advisory model | Projection only; not an executor or permission grant |

The default remains the existing Workflow/Command path. pgflow and pg_durable
are specialized integrations, not additional interchangeable defaults. Their
different cancellation, replay and retry semantics are not hidden behind a new
universal executor interface.

## Change Boundary

- Freeze expansion into another general workflow engine, visual designer or
  dynamic policy language until a real consuming flow demonstrates a gap.
- Keep optional packages out of the minimal starter and browser SDK dependency
  path. Their presence in the repository does not imply publication or deployment.
- Keep current jobs and ledgers intact. Removing a package cannot delete queued
  work, leases, receipts, approvals, audit history or recovery evidence.
- Before replacing an engine, record the affected consumer, inflight drain,
  identity mapping, no-resend recovery, rollback and authenticated acceptance.
- New reuse must reduce repeated application work. A matching API shape alone is
  not evidence of identical durable behavior.

## Required Scenarios

```gherkin
Scenario: A new application needs no durable engine
  Given the default minimal starter
  When dependencies and generated files are inspected
  Then no Worker or approval package is installed directly
  And no workflow ledger or synthetic approval schema is created

Scenario: A network failure leaves a write uncertain
  Given a dispatched external business command without a confirmed result
  When recovery runs
  Then it looks up the original receipt or external authority
  And it does not create a new operation or resend the side effect

Scenario: An engine is retired
  Given existing inflight work and audit records
  When a replacement is proposed
  Then migration and recovery acceptance are required before removing the old path
  And historical records are not deleted to simplify the codebase
```

This is a selection and maintenance policy, not a claim that all adapters have
passed live acceptance or that existing ledgers have been migrated.
