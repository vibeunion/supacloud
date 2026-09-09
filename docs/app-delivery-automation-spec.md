# Automated App Delivery

Status: stages 1-2 implemented as read-only `plan` and local `build-delivery`.
Stage 2 exports independent module factories, not deployable HTTP handlers.
Every target is rebundled; unchanged immutable artifacts are reused.
Stages 3-4 remain proposed. No production deployment is authorized by this document.
Date: 2026-09-09

## Job To Be Done

Let a developer describe a business capability and receive tested application
changes without manually maintaining function entrypoints, bundles, and deployment
manifests. Keep runtime placement deterministic and security decisions explicit.

## Existing Foundation

The compiler CLI exposes context, compile/check JSON diagnostics, and preview-first
structured fixes. Extend these surfaces instead of creating a separate AI compiler.
The existing application generator emits a shared application factory and manifest;
the delivery builder projects it into target-local factories and an atomic local
inspection manifest. Existing compile/check/dev output remains unchanged.

## Ownership

- The user owns business intent and authorization to change production.
- AI proposes source edits and typed, runtime-validated capability declarations.
- The compiler deterministically resolves dependencies, routes, and target plans.
- Build and test tools produce evidence; AI cannot substitute its judgment for gates.
- The deployment executor verifies environment identity, approval, and live receipts.

AI must not infer elevated permissions, public exposure, secret access, or
asynchronous business semantics from names or prose without explicit declarations.
An ambiguous declaration produces an actionable diagnostic, not a guessed placement.

## User Workflow

1. Describe the capability; AI produces acceptance tests and edits business source.
2. Compile the source into a preview of behavior, target, and permission changes.
3. Run type checks, contract rejection tests, and affected behavior tests.
4. Preview locally; deploy only to an explicitly configured and authorized test target.
5. Present a concise release decision with evidence and any required approval.
6. Promote the exact validated artifacts and read back their active state.

Show only changed behavior, verification status, and required decisions in the
normal summary. Expand diagnostics and target plans on demand.
Empty projects use a single API target. Running operations expose progress.
Failures preserve the last good generated output and provide a retryable diagnosis.

## Deterministic Placement

The initial policy has a small, versioned set of target profiles:

- Interactive HTTP routes default to api.
- Explicitly declared queued jobs use jobs when an authorized queue adapter exists.
- Webhooks use a separate target only when declared credential or ingress boundaries
  require it; webhook verification remains mandatory.
- Schedules enqueue declared jobs; they do not duplicate job business logic.

Each exposed route and job has one declared owner. Dependency traversal includes
providers without implicitly exposing routes from their modules. Conflicting
ownership, unavailable adapters, and unsatisfied isolation requirements fail closed.

Do not automatically convert a synchronous route into an asynchronous API. That
changes its contract and requires explicit source and acceptance-test changes.
Do not move workloads based on live measurements in the first version.
Existing deployments require a reviewed topology migration before changing owners.

## Compiler And Artifact Contracts

Use one runtime schema source for configuration, plans, receipts, and derived types.
Validate external data before entering typed compiler or deployment code.

A target plan records policy/schema versions, exposed routes/jobs, dependency closure,
capability references, required isolation, reasons for placement, and diagnostics.
It includes no secret values. Sorting and hashing must be stable.

Produce one self-contained bundle directory per target, including required assets.
Preserve public URL contracts through explicit gateway mappings when targets change.
Generate target-local factories and manifests plus a global inspection manifest.
Keep the current single-target behavior as the compatibility default.

Incremental build identity includes source and dependency hashes, lockfile, compiler,
bundler, policy, build configuration, and non-secret environment contract versions.
Shared dependency changes invalidate every affected target. Uncertain dependencies
invalidate conservatively. Removed artifacts are cleaned only within owned output.

## Runtime And Delivery

Separate target names are not proof of resource or security isolation.
Targets declaring process isolation require a host capability check and independent
process resource enforcement. Unsupported hosts reject the plan.

Jobs require a durable queue, bounded retries, idempotency, cancellation semantics,
failure handling, and transaction/outbox integration where submission accompanies
a database mutation. Do not promise exactly-once external effects.

Publish immutable artifacts with per-target hashes and activation preconditions.
Validate target host/project/environment before remote writes.
Bind approvals to the plan digest, artifact digest, environment, and expiry.
Material changes invalidate approval.

Perform complete applicable type checks and required build gates before integration
or release, even when affected tests suffice for the local edit loop.
Smoke tests must exercise declared routes and expected authorization failures.
An unknown activation outcome triggers read-back before any retry.
Database compatibility and irreversible side effects can prevent safe rollback;
report these cases instead of blindly rolling back bundles.

## Automation Limits

Local compile/test/preview can run automatically inside the authorized workspace.
Automated repair has bounded attempts and stops on repeated diagnostics or no progress.
It cannot disable type checks, weaken schemas, remove meaningful tests, expand
permissions, or mutate generated files to hide a source defect.

Test deployment requires prior authorization scoped to a concrete environment.
Production promotion, destructive migrations, new public routes, broader credentials,
and weakened isolation require explicit approval or a preapproved policy covering
the exact action. Never infer production permission from a general automation request.

This is an invoked delivery workflow, not a recurring unattended scheduler.

## Acceptance Scenarios

```gherkin
Feature: Deterministic automated app delivery

  Scenario: Ordinary business edits preserve simple deployment
    Given an application with interactive routes and no special workload declarations
    When the same validated input is planned twice
    Then both plans have identical canonical content and digests
    And all routes belong to the single api target
    And imported providers do not expose additional routes

  Scenario: Explicit jobs require their runtime guarantees
    Given a declared queued job requiring process isolation
    When the selected host lacks that isolation or a durable queue adapter
    Then planning or deployment fails with an actionable diagnostic
    And no route is silently converted to asynchronous behavior
    And no remote activation occurs

  Scenario: Incremental work preserves complete release gates
    Given two targets sharing a provider and one unrelated target
    When the shared provider changes
    Then both dependent targets are invalidated
    And the unrelated target is reusable only with a matching complete build identity
    And release still requires complete applicable type and build gates

  Scenario: Unsafe repair cannot complete the workflow
    Given invalid external configuration or a contract rejection test failure
    When AI attempts to deliver the change
    Then runtime validation or the test gate rejects it
    And bypassing type checks, schema checks, or meaningful tests is not permitted
    And repeated unsuccessful repair stops with evidence

  Scenario: Production activation is scoped and recoverable
    Given approved artifacts and a plan bound to a specific production environment
    When the plan changes or activation returns an unknown outcome
    Then a changed plan cannot reuse the approval
    And an unknown outcome is resolved by reading active state before retrying
    And success requires matching activation receipts and route smoke evidence
```

## Implementation Sequence

Stage 2 acceptance:

```gherkin
Feature: Local independent delivery artifacts
  Scenario: Routes stay within their owning target
    Given two HTTP targets sharing providers and a declared Job
    When delivery artifacts are built
    Then each bundle exposes only its owned routes or jobs
    And command governance and dependency factories are retained

  Scenario: Shared source changes affect dependent artifacts
    Given three targets, two of which import a shared implementation
    When the shared implementation changes
    Then the two dependent input digests change
    And the unrelated artifact is reused without changing its files
    And all targets still undergo validation and bundling

  Scenario: Invalid builds preserve the last successful release
    Given an existing delivery manifest
    When a source, generated-type, asset, or bundle check fails
    Then the current manifest and referenced artifacts remain unchanged

  Scenario: Artifact ownership is enforced
    Given an unowned output directory or a symlink inside the owned namespace
    When a build tries to write there
    Then it fails without replacing unrelated files

  Scenario: Topology changes do not deploy themselves
    Given an earlier manifest with a target that is now removed
    When a new local build succeeds
    Then the active local manifest excludes that target
    And old immutable objects remain available for inspection
    And no gateway or remote activation is performed
```

1. Add validated target declarations, a deterministic dry-run planner, reasons,
   dependency closure, and ownership diagnostics. No deployment side effects.
2. Add per-target emission, independent bundles, stable public route mappings,
   dependency-sensitive caching, and compatibility regression tests.
3. Connect authorized test deployment and immutable promotion to existing delivery
   tools; add receipt reconciliation and host isolation checks.
4. Integrate the bounded AI edit/diagnostic/test loop using existing context packs.

Non-goals: one function per route, arbitrary AI deployment decisions, runtime
self-repartitioning, automatic production access, and a new orchestration UI.
