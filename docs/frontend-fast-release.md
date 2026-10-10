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
  When deployment reads the current authority
  Then a single-record inventory is used
  And exact immutable artifact readback remains required after activation

Scenario: Refuse unsafe downgrade
  Given authentication failure or an invalid active snapshot
  When deployment reads the authority
  Then deployment stops without activation or history fallback

Scenario: Rollback without reupload
  Given a previous immutable release and the new CAS activation identity
  When the previous release is activated with that expected identity
  Then the platform reuses the retained artifact
  And database and Storage state are not restored
```

Test and production use the same identity/integrity gates. Full history audit
is an explicit operation, not a routine publish prerequisite. No measured
production latency improvement is claimed by the local tests.
