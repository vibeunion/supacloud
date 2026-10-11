# Application Promotion Execution

## Scope

Promotion execution is a durable orchestration over an immutable plan. The
plan remains read-only and is never treated as authorization by itself.

The composed Management API provides `ApplicationPromotionExecutor` and
`POST /v1/projects/:ref/applications/:id/environments/:environmentId/promotions`.
It persists the reviewed plan, request fingerprint, stable backup identity and
independent activation identity before effects. One parent mutation owns the
same fenced resource as direct activation; no second operation ledger is used.

For pending project SQL, it holds one database advisory lock from inventory
through backup publication, exact backup readback, migration execution, and
full projected-ledger readback. Backups and per-migration transactions reuse
the held lock. Unsupported/nontransactional SQL and operator provisioning are
blocked; destructive SQL requires the exact execution-plan digest.

The default SQL adapter is shared with the database route: project migration
role, transaction wrappers, ledger lease, schema reload, and session reset
remain unchanged. A batch can partially commit before an error; the service
never retries SQL or restores data. The caller must preserve the durable
unknown outcome and inspect the ledger before deciding recovery.

The scenarios below are the promotion-level acceptance contract. Executor,
activation delegation, execution API and promotion status/reconcile APIs have
local regression coverage. CLI execution, no-op handling, scoped status/reconcile
and preview commands have focused local coverage. Native PostgreSQL acceptance
remains separate work. Generic mutation status does not substitute for observed
reconciliation.

Promotion and activation cannot independently claim the same
`application_release` mutation resource. Activation phases are nested inside
the parent checkpoint. The active authority records the parent mutation ID and
an independent activation ID; future promotion planning verifies both against
the exact durable request, plan and complete success receipt. A running parent
can verify its own completed activation but cannot authorize another promotion.

The internal `readOwnedPlan` revalidation path may observe the target only while
the caller holds the exact promotion resource lease. It verifies the database
lease token, fencing epoch, project, operation, principal, request fingerprint,
and canonical application/environment resource under the same transaction.
The source must remain idle. Public `readPlan` has no owner bypass. This is not
activation delegation and must not be called inside an outer `protect` callback
that already holds the same mutation row lock.

Authenticated smoke is executed through the root-owned, non-writable
`/etc/supacloud/application-verifiers/<project>/<application>/<environment>/smoke`.
The program receives `supacloud.application-smoke-request.v1` JSON on stdin:
`nonce`, `input_sha256`, and `input` containing the exact active authority and
resolved environment values. Configuration values are never persisted in the
mutation or echoed into errors. Uploaded artifacts cannot supply this program.
The bounded stdout receipt must use `supacloud.application-smoke-result.v1`,
echo the nonce and input digest, set `authenticated: true`, and provide a
`supacloud.deployment-evidence.v1` `evidence` object. Missing verifier, stale
timestamps, mismatched authority or migration ledger, or unknown authenticated
smoke leaves promotion unresolved. Generic readiness cannot satisfy this gate.

`GET .../promotions/:mutationId` exposes only fixed mutation metadata, the last
durable phase and release/configuration/activation/backup identities. It never
returns the arbitrary journal, configuration values or lease token. Target
authorization and the original mutation principal remain mandatory.

`POST .../promotions/:mutationId/reconcile` accepts an empty body, not caller
evidence. Only `outcome_unknown` in the verifying phase may enter recovery.
Source artifact and runtime access are authorized again using the persisted
request. The internal `readReconciliationPlan` path must match the exact current
unknown resource journal and fencing epoch at every observation boundary; it
does not grant an execution lease. Public `readPlan` still blocks this resource.
The delegated activation must already be fully committed, and current authority,
route/runtime readback, configuration, candidate artifact, migration ledger and
fresh authenticated smoke must all match. The ledger must match the durable
migration result (or the original ledger when no SQL was pending). Saved
verification evidence, when present, must also match. Repeated observations must
remain unchanged before the existing fenced recovery writes its success receipt.

Successful replay accepts the exact execution or recovery receipt and observes
current authority without transfer, backup, migration, allocation or activation.
Existing unfinished checkpoints cannot be overwritten by retries. Unknown
database or runtime effects without complete, matching observations remain
unresolved. Reconciliation performs no SQL, backup, runtime re-execution,
automatic downgrade or database restore.
No native PostgreSQL lease acceptance, test/production deployment or online
business acceptance has been performed for this integration.

## Acceptance criteria

```gherkin
Feature: Promote an application between environments

  Scenario: Apply pending project migrations after a verified backup
    Given a fresh plan digest with an idle source and target
    And the target has no migration conflict or operator-provisioning blocker
    When SupaCloud starts promotion with a stable operation id
    Then it records the operation checkpoint before any artifact or database effect
    And it verifies the backup receipt before applying each pending migration
    And it reads the target ledger back before activating the release

  Scenario: Replay a completed promotion
    Given the same operation id has a verified successful mutation receipt
    When the client retries the promotion
    Then SupaCloud performs no transfer, backup, migration, or activation effect
    And returns the original receipt after exact readback

  Scenario: Recover an interrupted promotion
    Given a promotion stopped after an uncertain database or runtime effect
    When the client requests status or reconciliation
    Then SupaCloud reports the last durable phase and outcome as unresolved
    And never blindly replays the uncertain effect

  Scenario: Confirm a lost final success receipt
    Given the parent outcome is unknown but its delegated activation is committed
    And current authority, route, runtime, candidate, configuration, migration ledger
      and fresh authenticated smoke match the durable journal
    When the original principal requests reconciliation with source read access
    Then SupaCloud writes only a fenced recovery receipt after repeated readback
    And the same operation id can be replayed without repeating deployment effects
    And stale smoke, competing epochs, changed journals and foreign identities are rejected

  Scenario: Reject a changed plan
    Given the target ledger, configuration, source release, or active revision changed
    When a promotion is started with the old plan digest
    Then SupaCloud rejects the operation before its first effect

  Scenario: Treat no-op as an observed state
    Given the candidate release, configuration, activation receipt, readiness and fresh
      authenticated smoke all match
    When the plan is read
    Then the action is no-op and promotion creates no mutation

  Scenario: Verify activation receipts against the stored resource identity
    Given the journal stores the canonical v1 application release resource key
    When promotion, activation replay, or recovery verifies a successful receipt
    Then it accepts only the exact project, operation, activation, application and environment
    And rejects bare digests and resource keys for other resource types

  Scenario: Revalidate a plan while its promotion owns the target
    Given a running promotion holds the exact target resource lease
    When the internal executor revalidates its immutable plan
    Then only that promotion is permitted as the target resource owner
    And the source must still have no unresolved operation
    And expired tokens, stale fencing epochs and changed request identities are rejected
    And the public planning endpoint remains blocked by the promotion

  Scenario: Delegate activation without releasing promotion ownership
    Given the promotion holds the exact target lease and has persisted its original plan
    And its checkpoint enters the activating phase before runtime effects
    When the existing activation controller starts the planned candidate
    Then each activation phase is saved inside the same promotion checkpoint
    And no child mutation row or second resource owner is created
    And activation success leaves the promotion running in its verifying phase
    And the original plan, stable backup identity and migration evidence remain intact

  Scenario: Reject an interrupted or competing activation delegation
    Given the promotion already has an activation attempt in its checkpoint
    When another caller attempts the same delegation
    Then it cannot replay preparation, stop, start or routing effects
    And only a completed attempt may be re-observed without effects
    And a lost parent lease cannot change the checkpoint or runtime
```

Database restore and application release rollback are separate commands. A
release rollback must not silently restore business data.
