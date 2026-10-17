# Managed Preview Cleanup

The platform owns preview expiry, discovery, admission fencing, resource cleanup
and receipts. The CLI does not run SSH or individually delete databases, queues,
Storage namespaces or Secrets.

Receipt reads and list operations are observational only. Reconciliation is an
explicit `POST .../previews/:previewId/reconcile` operation and must be selected
by Preview ID; a GET never resumes provisioning.

New previews expire after 24 hours by default. An explicit `ttl_seconds` may
select 5 minutes through 7 days. Plans have no deadline unless one is supplied.
Stored receipts without an expiry are not automatically adopted by the worker.
Expiry is eligibility for cleanup, not permission to interrupt a serving
application or discard unverified Storage contents.

## Configuration Recovery

Creation pins the supplied source configuration revision, or reads and pins the
current head once when no revision is supplied. Provisioning persists the target
configuration ID before cloning and reuses it on recovery. A clone whose ready
receipt was not committed is retried with the same source revision and target
ID through the immutable configuration writer. It does not allocate another
revision or reset a newer target head.

Receipts without a pinned source revision cannot adopt a later mutable head.
A missing source or mismatched clone identity cannot produce a ready preview.
## Acceptance

```gherkin
Scenario: Discover expired previews without a CLI session
  Given an expired persisted preview
  When the platform maintenance worker runs
  Then it attempts the existing cleanup workflow
  And retains the receipt and immutable release evidence

Scenario: Do not destroy a serving or uncertain activation
  Given an active application or an unretired runtime allocation
  When automatic preview cleanup is requested
  Then cleanup is blocked before queue, Secret or database deletion
  And the receipt remains available for reconciliation

Scenario: Failure remains retryable and truthful
  Given a queue, Secret, Storage or branch teardown failure
  When cleanup observes the failure
  Then cleanup is not completed
  And the verified earlier phases are retained for the next attempt

Scenario: Cleanup and provisioning cannot race
  Given two control-plane processes handling the same preview
  When one owns its lifecycle lock
  Then the other cannot provision or clean its resources concurrently
  And stale receipt CAS cannot overwrite the winning state

Scenario: Recover a committed configuration without allocating a new revision
  Given a pinned source revision and a persisted target configuration ID
  And the clone committed before its ready receipt could be saved
  When a restarted control plane resumes provisioning
  Then it clones the same source into the same target configuration ID
  And does not read the mutable source head
Scenario: Persist cleanup intent before interrupting a selected preview
  Given an explicitly selected active preview
  When the cleanup intent cannot be committed
  Then no application process or gateway route is stopped

Scenario: Do not infer cleanup from a soft-deleted project
  Given a branch row is absent but its database still exists
  When cleanup reads back resource state
  Then the receipt does not become cleaned
```

An activated preview still needs explicit application deactivation/retirement
before resource cleanup. Unknown activation outcomes require reconciliation.
Storage containing objects is not automatically emptied. Expiry never restores
a database, reverses a migration, promotes an environment or authorizes
production deployment. Local tests, PR creation, merge, rollout and online
acceptance remain separate evidence.
