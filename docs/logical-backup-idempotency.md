# Logical Backup Operation Identity

Pre-release backups belong to SupaCloud, not application deployment scripts.
This change supplies stable backup identity and authoritative readback for the
durable application promotion executor. It does not implement that executor,
run migrations, or automatically restore business data.

## Contract

- `POST /v1/projects/:ref/database/backups/logical` accepts an optional
  `backup_id`. IDs have the form `logical-full_<ref>_<32 lowercase hex digits>`.
  Internal promotion operations can use their UUID without hyphens as the
  suffix; the CLI generates an ID before its first network request.
- Reusing an ID means reusing the same snapshot, not creating a fresh snapshot.
  A completed backup is verified again by signed receipt, database identity,
  archive digest, size, file identity and `pg_restore --list`.
- Creation and recovery use the existing project migration lock. An incomplete
  archive without a verified pending receipt is not overwritten or redumped.
- A verified pending receipt can be published by an explicit creation retry.
  Interrupted publication of the same receipt is reconciled without executing
  another dump. Reads never perform publication, directory creation or cleanup.
- `GET /v1/projects/:ref/database/backups/logical/:backupId` verifies that exact
  backup. Missing IDs return 404; unfinished publication returns 409; invalid
  archives or receipts return a redacted 503.
- Logical backup access remains admin-only. Database restore still requires a
  paused project and exact `RESTORE_PROJECT:<ref>:<backup_id>:<sha256>`
  confirmation.

## CLI

```sh
supacloud release logical_backup_create --ref example
supacloud release logical_backup_status --ref example --backup_id logical-full_example_<32hex>
supacloud release logical_backup_create --ref example --backup_id logical-full_example_<32hex>
```

Creation sends one POST followed by one exact-ID GET. An uncertain mutation can
be observed by that exact GET, but is never automatically retried or upgraded
to creation success by a read alone. A published file does not prove that the
original creation request's directory synchronization succeeded.
Unknown outcomes retain `project_ref` and `backup_id`; neither a missing backup
nor failed observation is treated as successful creation. Invalid successful
mutation receipts are not replaced by unrelated observations.
Successful observation after an uncertain POST returns `OUTCOME_UNKNOWN` with
`backup_verified: true`, `creation_confirmed: false`, and the safe backup
projection. Retrying creation explicitly with the same ID re-verifies and
directory-syncs existing publication without another dump.

This removes two whole-inventory scans from creation and allows observation
even when an unrelated backup is corrupt. It does not change restore semantics
or constitute a database restore drill.

## Acceptance

```gherkin
Scenario: Retry a completed pre-release backup
  Given an operation has a stable project-bound backup ID
  And a signed receipt and matching archive have been published
  When creation is requested again with that ID
  Then SupaCloud revalidates and returns the same receipt
  And it does not run another pg_dump

Scenario: Recover interrupted receipt publication
  Given a complete archive and a verified pending receipt for the same ID
  When creation is explicitly retried
  Then SupaCloud verifies and publishes that receipt
  And it does not overwrite the archive or run another pg_dump

Scenario: Observe an incomplete backup without writes
  Given only an unconfirmed archive remains for an operation
  When its exact status is requested
  Then SupaCloud reports a conflict without changing files
  And a creation retry cannot silently replace the archive

Scenario: Concurrent operations share the project migration lock
  Given a migration or backup already holds the project's database lock
  When another creation request arrives
  Then no pg_dump or receipt publication is performed
  And the caller retains the selected backup ID for later observation

Scenario: Creation response is lost
  Given the CLI generated a stable backup ID before sending one POST
  When the mutation response is uncertain
  Then the CLI observes that exact ID without resending the POST
  And a read alone does not confirm successful creation
  And successful observation exposes the verified backup with creation unconfirmed
  And otherwise the error retains the backup ID
```

## Remaining Work

The application promotion executor must durably bind the ID before starting
backup creation and verify backup age and migration-ledger drift before SQL.
Stable ID reuse alone does not prove that a snapshot is fresh enough for a new
promotion operation. This change does not quiesce business writes, guarantee
PITR, delete partial archives, or prove live test/production acceptance.

## Focused Verification

Run each test file independently; the service test deliberately isolates module
mocks and uses PostgreSQL subprocess substitutes, not a live database.

```sh
bun test packages/management-api/tests/unit/logical-backup.service.test.ts
bun test packages/management-api/tests/unit/backup.routes.test.ts
bun test packages/cli/src/shared/tools/release-tools.test.ts
bun run --cwd packages/management-api typecheck:logical-backup-tests
git diff --check
```
