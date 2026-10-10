# Application Activation History

`app history` observes completed successful activation events for one application
environment. Uploaded artifact inventory is not deployment history. Completion
order is not activation lineage order: reconciliation may settle an older event
after a newer activation. Each event therefore includes its previous activation
ID and whether it matches the current authority.

```bash
supacloud-cli --env test app history --id reviews --environment_id test
supacloud-cli --env test app history --id reviews --environment_id test --limit 20 --json
supacloud-cli --env test app history --id reviews --environment_id test --cursor <next_cursor> --json
```

The platform reuses the existing private mutation journal, validates successful
receipts and request fingerprints, and returns only public identities. Keyset
pagination uses the exact UTC completion timestamp and activation ID. It never
builds, allocates, migrates, activates, restores, or scans immutable artifacts.
History is not proof of retained artifact availability, runtime health or rollback
readiness; use runtime observations and the verified rollback snapshot for those.
Text mode shows completion time, the current marker, full activation IDs and short
release IDs. `--json` or `--format json` returns full identities and predecessor
links. Empty pages are explicit; a next-page cursor is displayed only when present.
Concurrent observations fail with 409; retry the read, never replay a write.

## Acceptance

```gherkin
Scenario: Observe completed versions without guessing from artifact order
  Given successful activation journals for one application environment
  When history is requested
  Then events are ordered by completion time and activation ID descending
  And each entry has its exact release, configuration and previous activation ID

Scenario: Read the next page without losing events completed in the same millisecond
  Given more events than the requested page size
  When the returned cursor is used
  Then exact microsecond timestamps and activation IDs select the next page
  And events are neither duplicated nor skipped

Scenario: Reject untrustworthy evidence
  Given a foreign, incomplete or contradictory successful journal
  When history is requested
  Then no partial history or private provider error is returned
  And no activation or reconciliation is performed

Scenario: Refuse an inconsistent observation
  Given an activation or journal changes while history is being observed
  When the final authority and journal readbacks occur
  Then the request fails with an observation conflict
  And the client does not automatically replay a write

Scenario: Keep project authorization and client validation
  Given an unauthorized request or a malformed history response
  When the history API or CLI is used
  Then access is rejected before journal reads or output of untrusted data
```

This is a read-only release inspection feature. Local tests, PR submission, merge,
deployment, online acceptance and measured deploy latency remain separate.
