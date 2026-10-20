# Approval Feature Slice: Scope And Results

Date: 2026-10-14. Status: scaffold implementation, not completed adoption.

## Product Outcome

Reduce the work needed to add an approved business change, including failure
handling, rather than optimize package or decorator counts. Use the existing
xigu-fa approval flow as the domain reference; do not replace its authoritative
RPCs, receipts, permissions or state tables.

This iteration adds `app generate --kind feature` to the existing generator.
It creates nine files, including a typed fixture, a standard pending-command
client adapter and an authenticated E2E
entry point, and reuses preflight/preview/registration/rollback behavior,
and requires explicit permission and RPC capability names. It does not add a
second engine, database schema, hand-maintained client or transport abstraction.

## Four Requested Outcomes

| Outcome | This iteration | Remaining evidence |
| --- | --- | --- |
| Golden business slice and four-stack comparison | Approval scope and common acceptance below; recorded-agent evaluator has a bounded `create-feature-slice` task | NestJS, Spring, a named Go stack, and SupaCloud implementations and comparable measured trials |
| Feature generator | HTTP schemas, read/write ports, Query, governed Command, state declaration, job placeholder, receipt and job-status routes, explicit query invalidation tags, standard pending-command client adapter, unit tests, typed fixture, authenticated E2E entry point and delivery checklist generated together | Real database bindings, generated browser client adoption, configured E2E execution and delivery read-back |
| Default business mechanisms | Reuses existing compiler/runtime governance instead of creating parallel mechanisms; rejects missing explicit capabilities | Durable authorization, version checks, audit, outbox and result recovery in the chosen customer flow |
| Earlier rejection | Generated Command requires the registered persistent RPC; compilation checks state/route/governance consistency | Universal tenant/query inference, arbitrary table-write detection and dynamic state correctness are not claimed |

Invalidation tags are explicit transition metadata and are preserved in the
contract manifest and generated procedure metadata. The generated approval
recipe exports the list/detail/receipt tags for `@supacloud/query`; query
options and mutation success handlers consume that metadata by default and
never infer tags from route or procedure names.

The platform can remain usable without the application framework while the
framework is treated as a first-class product. Do not require all platform users
to install it merely to demonstrate its importance.

## Golden Slice Contract

Use two tenants, an author, a separate reviewer and a revoked reviewer. Start with
an existing draft whose version and membership are stored in PostgreSQL. All
implementations must expose the same list, detail, approval, receipt recovery and
asynchronous job-status behaviors. Use the same browser flow and fault-injection
requests; do not compare a memory demo against a persistent application.

```gherkin
Scenario: Read and authorize
  Given two tenants and an authenticated reviewer in only one tenant
  When the reviewer lists and opens an approval
  Then only that tenant's authorized records are visible
  And an author cannot approve their own record

Scenario: Approve atomically and replay
  Given a draft and its current database version
  When approval is submitted twice with identical input and idempotency key
  Then one state change, receipt, audit event and outbox intent commit
  And a conflicting replay or stale version changes nothing
  And revoked access prevents disclosure of a cached success

Scenario: Crash and recover
  Given approval committed but its response or worker acknowledgement was lost
  When the client and worker recover using the original identities
  Then they consult durable state without repeating a business side effect
  And a refresh failure does not relabel committed approval as rejection

Scenario: Reject broken wiring before serving
  Given a command missing permission or its persistent adapter
  When the application is compiled or constructed
  Then it fails without replacing good artifacts or accepting protected work

Scenario: Deploy and upgrade
  Given reviewed forward migrations and an explicit test environment
  When the application is deployed then upgraded with existing pending work
  Then release read-back and authenticated acceptance pass
  And existing receipts and job recovery identities remain usable
```

## Measurement Rules

Fix the task, database, acceptance suite, developer/agent context, dependencies,
hardware and deployment environment before trials. Name and pin a concrete Go
framework/library combination; "Go" alone is not a comparable product.

Record handwritten and generated production files/lines separately, including
SQL, config and glue. Record tests separately as well. Count nonblank physical
lines with the same rule across stacks; do not exclude handwritten migrations
or copied boilerplate. Include adapter integration time. First runnable time
ends when the real database-backed HTTP acceptance passes, not at generation
or health-check success.

| Metric | SupaCloud | NestJS | Spring | Named Go stack |
| --- | --- | --- | --- | --- |
| Handwritten files and lines | Not measured | Not measured | Not measured | Not measured |
| Time to first runnable slice | Not measured | Not measured | Not measured | Not measured |
| First-check failures | Not measured | Not measured | Not measured | Not measured |
| Authorization/idempotency/state defects | Not measured | Not measured | Not measured | Not measured |
| Deployment and stateful upgrade time | Not measured | Not measured | Not measured | Not measured |

Generator regression timings are not these benchmarks. The existing evaluator
records agent trials and scope violations; it does not measure LOC, independent
security correctness or deployment itself. Its result is not independent
attestation. No improvement ratio or ecosystem ranking is established here.

## Local Verification

- Feature-generator regression: preview/apply, explicit capability requirements,
  parent registration, conflicts, compiler acceptance/rejection and generated
  fixture/service tests, explicit invalidation-tag generation, E2E entry-point
  generation and type checking.
- Existing app-tool regression: 21 tests passed.
- Recorded-agent evaluator: 4 tests passed, including cross-feature scope denial.
- CLI typecheck and build passed.
- An earlier resource-generator attempt failed type resolution. The follow-up
  rerun passed all 13 tests, and packed-consumer acceptance passed with the local
  candidate tarballs. This resolves that local acceptance gap, not npm publication.
- No database, browser, deployment, npm publication or comparative trial was run.

### Packed Consumer Follow-up

`bun scripts/check_app_generation.ts` passed using the installed candidate CLI
outside the workspace, frozen/offline consumer reinstall, and Bun 1.4.3:

- Original HTTP/resource tests, consumer typecheck/build and edge checks passed.
- Feature preview/apply, required flags and registration conflicts passed.
- Missing named compiler capability rejected compile/check without modifying
  existing generated artifacts, both before and after successful feature builds.
- Generated feature tests, consumer typecheck/build, and runtime rejection of a
  missing RPC adapter passed.
- Explicit test doubles verified list/detail routes, authorization before RPC,
  validation before writes, successful delegation and redacted unbound-port errors.
- Feature-generator regression passed all 6 tests; `git diff --check` passed.

The unmodified HTTP memory demo rejects a newly registered durable command because
it lacks the named RPC adapter. Acceptance checks the original demo first, then
the durable feature separately; it does not insert a production memory fallback.
The fixture's pass-through adapter proves wiring only, not persistence, tenant
authorization, idempotency, state transitions, audit or outbox behavior.

## Remaining Work

1. Bind this recipe to one approved xigu-fa operation using its existing RPC and
   source-of-truth tables; keep authorization and state rules in that application.
2. Connect the generated Feature client adapter and compiler-generated client
   with the existing query adapter in the
   browser, bind the generated job-status port to the existing Workflow/Queue
   read path, configure
   the generated E2E environment, then run authenticated negative, concurrency,
   crash and recovery acceptance.
3. Verify the published dependency tuple and test-environment deployment/upgrade.
   Local candidate-package acceptance is complete; publication is not verified.
4. Implement the three comparison stacks against the same contract and record
   repeated trials. Only then evaluate the "large project becomes medium" claim.
