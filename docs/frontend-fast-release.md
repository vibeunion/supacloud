# Fast Frontend Release

Scope: reduce deployment observation cost without changing activation, backup
retention, authorization or database recovery semantics.

The old deploy path requested 100 historical releases and integrity-checked
each archive and extracted tree before deployment and again after activation.
The active snapshot makes that work independent of retained history size.
Current artifact verification, CAS and exact post-activation readback remain.

`tree_sha256` binds all extracted files sorted with `path.localeCompare`.
Each entry hashes a 12-byte frame (big-endian uint32 UTF-8 path length,
big-endian uint64 byte size), UTF-8 path bytes and the 32 raw SHA-256 bytes.
An application that validates a retained artifact through its public manifest
must include the manifest's actual byte length and SHA-256 in that same tree;
matching the file count alone is not evidence of a matching build.

## Platform Ownership

- SupaCloud stores and verifies immutable ZIPs and trees.
- SupaCloud owns the active release/activation authority and CAS mutation ledger.
- SupaCloud selects the previous release from the verified activation journal,
  not history ordering, and verifies both retained artifacts in one locked snapshot.
- Callers retain release IDs and receipts, not a second copy of the old website.
- Legacy deployments without immutable authority must first establish a real
  rollback artifact. A missing artifact never means rollback-ready.
- Database migrations and Storage changes need their own backup/recovery policy.
  The frontend fast path does not waive these gates or restore data.

## Acceptance

```gherkin
Scenario: Release history does not delay a routine publish
  Given many retained immutable frontend releases
  When the active release snapshot is requested
  Then only the current artifact and activation identity are verified
  And no historical archive is inspected

Scenario: Preserve read-only and project boundaries
  Given a read-only CLI context for one project
  When get_active_release is requested
  Then a secret-free exact project/deployment projection is returned
  And no mutation or backup is created

Scenario: Older server compatibility
  Given an older server whose active endpoint returns 404
  When any CLI consumer requests get_active_release
  Then the CLI automatically reads a single-record inventory
  And reads the exact release named by the authoritative active release ID
  And returns the same zero-or-one snapshot contract
  And exact immutable artifact readback remains required after activation

Scenario: Refuse unsafe downgrade
  Given authentication failure or an invalid active snapshot
  When deployment reads the authority
  Then deployment stops without activation or history fallback

Scenario: Rollback without reupload
  Given a previous immutable release and the new CAS activation identity
  When frontend rollback is requested with that release ID
  Then the CLI obtains the current CAS identity and creates the mutation ID
  And the platform reuses the retained artifact
  And a concurrent deployment is rejected without retrying with its new identity
  And database and Storage state are not restored

Scenario: Platform selects the previous activation
  Given a succeeded activation journal with a verified previous immutable release
  When frontend rollback is requested without a release ID
  Then the platform supplies the previous release and current CAS in one locked snapshot
  And no history list, rebuild, download or upload is needed

Scenario: Previous activation cannot be proven
  Given a missing or invalid journal, an unresolved activation, or a corrupt previous artifact
  When a default rollback is requested
  Then no activation is sent
  And the client never guesses from release timestamps or content-hash order

Scenario: Older server cannot select the previous activation
  Given a server whose rollback snapshot endpoint returns HTTP 404
  When a default rollback is requested
  Then the client reports PREVIOUS_RELEASE_UNSUPPORTED without writing
  And an explicitly selected release still uses the existing compatibility reader
```

Test and production use the same identity/integrity gates. Full history audit
is an explicit operation, not a routine publish prerequisite. No measured
production latency improvement is claimed by the local tests.

## Developer Experience Contract

Product target: simpler routine delivery than a manually assembled Supabase CLI
pipeline, with Wrangler-like environment selection and short deploy/rollback
commands. This is a target, not a measured claim of competitive superiority.

An application must not choose API endpoints based on server version, implement
HTTP 404 fallback, scan history for the current release or construct routine CAS
rollback calls. CLI, Admin and deploy share one authority reader. Compatibility
is automatic only when the native read returns HTTP 404; it never disables
authorization, integrity validation, production confirmation or CAS.

```bash
supacloud-cli --env staging deploy
supacloud-cli --env staging frontend get_active_release --ref abc123 --id web
supacloud-cli --env staging frontend rollback --ref abc123 --id web
supacloud-cli --env staging frontend rollback --ref abc123 --id web --release_id <retained-sha256>
```

Default rollback uses the platform's verified activation journal; an explicit
target remains available for a deliberate operator choice. Release inventory is
ordered by content hash, not deployment time; neither the client nor application
may infer "previous" from its first record. The rollback snapshot already includes
the verified previous artifact, so no extra target GET is needed before activation.
Exact post-activation readback remains mandatory. An older rollback endpoint
returning HTTP 404 yields `PREVIOUS_RELEASE_UNSUPPORTED` instead of a guessed target.
On an uncertain rollback, report the mutation ID for read-only reconciliation;
do not generate another activation or automatically restore a database.
This command represents an explicit operator decision against the observed
current deployment. Automated compensation owned by an earlier release receipt
must use its original expected CAS identity, not observe and overwrite a newer
deployment through the high-level command.

## Ownership And Follow-Up

| Concern | Owner | Delivery boundary |
| --- | --- | --- |
| Older active endpoint compatibility | SupaCloud CLI/Admin | This PR: transparent, strict snapshot normalization |
| Immutable frontend artifact integrity and CAS | SupaCloud platform | Existing primitives plus active snapshot in this PR |
| Rollback target selection/activation without CAS/UUID boilerplate | SupaCloud platform/CLI | One command defaults to the journal-verified previous release; explicit retained targets remain supported |
| Current/previous activation authority | SupaCloud platform | Active and previous-release snapshots verified under the deployment lock |
| Full activation history, legacy artifact capture, protected retention/GC | SupaCloud platform | Follow-up; not achieved by CLI fallback |
| Environment bindings, public config versus credentials, initialization/doctor | SupaCloud compiler/CLI | Consolidate existing context/compiler paths; do not require every app to invent profiles |
| Build cache, content-addressed upload deduplication, skip unchanged resources | SupaCloud compiler/CLI/platform | Extend existing deploy identity support with measured cold/warm/no-op budgets |
| Migration risk classification, required backup before risky writes, schema cache/readiness | SupaCloud release platform | Follow-up on release controls; code-only must not perform database work |
| Backup job, integrity, retention and restore receipt | SupaCloud platform | Restore remains explicitly authorized; backup IDs are not sufficient proof |
| Multi-Function rollout and recovery | SupaCloud release platform | Proposed batch contract in release-control-automation-spec.md, not atomic today |
| Outcome-unknown reconciliation, progress, diagnostics, structured receipts | SupaCloud platform/CLI | Reuse mutation journal; do not blindly retry writes in application scripts |
| Health/readiness and declared application smoke hooks | SupaCloud platform executes, application declares | Platform handles execution/evidence; the app defines business assertions |
| FA business schema, RLS, domain states, OAuth claim expectations and business acceptance | FA | Not delegated to the platform or replaced by generic health checks |
| Git review/merge and production authorization | Repository/operator | Deploy must not silently merge or cross environments |

The next release milestone should test clean-workspace deploy, warm deploy,
unchanged deploy, rollback, older-server compatibility, concurrent deployment,
interrupted response and production mis-targeting. Record real end-to-end times
and command/flag counts before declaring the product target achieved.
