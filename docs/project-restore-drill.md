# Isolated full-project restore drills

## Acceptance

```gherkin
Scenario: Production cannot be an implicit restore target
  Given a signed complete snapshot and a new drill ID
  When a drill is started without network isolation or exact confirmation
  Then no database restore command runs
  And an existing drill directory is never reused or cleaned automatically

Scenario: Every component is required
  Given database, object files, encrypted runtime secrets and function metadata
  When an inventory digest or decryption authentication tag fails
  Then verification stops and no success receipt is issued

Scenario: Restored state is verified instead of assuming command success
  Given PostgreSQL has recovered into a new private cluster
  When permission, queue, business and function canaries are executed
  Then all expected results and the recovered snapshot marker must match
  And the receipt contains measured RPO and RTO, not configured estimates

Scenario: Interrupted execution is not replayed automatically
  Given a durable running receipt already exists for a drill ID
  When a process restarts or its response is lost
  Then the same ID is refused for execution
  And status exposes the signed receipt or an unknown outcome
```

The runner is an operator tool, not a public restore API. It only runs inside
a Linux Docker container with no non-loopback network interfaces. The database
cluster is always newly created under `/drill/<drill-id>`. The source project
ref is preserved inside this isolated namespace; this is not an in-place
restore or an automatic tenant rename. No command targets an existing stanza
data directory or invokes `pig pitr`.

The snapshot must be exported consistently by the backup operator. A manifest
binds database backup files, the complete exported object namespace, encrypted
runtime environment, and function/runtime files to one snapshot ID. Object
files are restored into an isolated filesystem namespace and checked byte for
byte. This does not provision a production S3 endpoint or claim provider-level
S3 version/ACL recovery. Applications that require additional services must
provide those services in a compatible isolated drill image; their canaries
fail rather than contacting production.

Both pgBackRest time-target recovery and portable logical-full fixtures are
supported and distinctly identified in receipts. A logical fixture is never
reported as PITR evidence. Physical restore remaps all tablespaces and uses
new local PostgreSQL configuration, sockets and loopback ports.

## Snapshot Contract

`/backup/manifest.json` is a signed JSON document using the exported
`RestoreSnapshot` TypeScript contract. Its `files` inventory covers every
regular file under `database/`, `objects/`, `runtime/`, and `secrets/`.
Symlinks, hardlinks, unknown files and path escapes are rejected.

- pgBackRest: repository files under `database/repo/`; exact stanza, backup set,
PostgreSQL major version and UTC recovery target are required.
- Logical: `database/database.dump` and `database/globals.sql`.
- Runtime files under `runtime/` become the isolated project's functions root.
- `secrets/runtime-env.enc` uses existing `enc:v1:` AES-GCM encryption.
  Its plaintext is `{snapshot_id, project_ref, values}`. No plaintext key is
  stored in the manifest or receipt.
- SQL fixtures include permissions, queues and business checks, with expected
  JSON rows and an explicit database role. A separate marker query returns
  exactly one `{snapshot_id, recovered_through}` row.
- HTTP fixtures are GET-only, include an anonymous denied request and a
  service-role successful function request, and pin response body SHA-256.

Sign the manifest excluding `signature` with HMAC-SHA256 over `stableStringify`.
The source signing key and recovery encryption key are independent inputs.
The runner signs its receipt with an independent drill receipt key.
For encrypted pgBackRest repositories, set `database.repo_cipher_type` to
`aes-256-cbc` and provide `SUPACLOUD_PGBACKREST_REPO_KEY` separately. It is
passed through the private process environment, never a command argument.
Recovery must reach the requested target and leave standby/recovery mode
before fixture verification can report success.

## Running

Build `infrastructure/restore-drill/Dockerfile` from the repository root.
Review and pin the resulting image digest before operational use.
Supply `SUPACLOUD_SNAPSHOT_SIGNING_KEY`, `SUPACLOUD_RESTORE_ENCRYPTION_KEY`,
and `SUPACLOUD_DRILL_RECEIPT_KEY` through the container's secret environment.
Never place their values on a command line or in a PR.

```sh
docker run --rm --network none --cap-drop ALL \
  --security-opt no-new-privileges \
  --mount type=bind,src=/absolute/approved-snapshot,target=/backup,readonly \
  --mount type=bind,src=/absolute/empty-drill-volume,target=/drill \
  --env SUPACLOUD_SNAPSHOT_SIGNING_KEY \
  --env SUPACLOUD_RESTORE_ENCRYPTION_KEY \
  --env SUPACLOUD_DRILL_RECEIPT_KEY \
  <approved-image-digest> run <drill-uuid> \
  RESTORE_DRILL:<project-ref>:<snapshot-uuid>:<drill-uuid>
```

The mounted drill volume must be private and writable by the image's postgres
user. It must not be a source/production volume. Retain the resulting
`/drill/<id>/receipt.json` privately; cleanup is an explicit operator operation.
Use the same image and receipt-key environment with `status <id>` to read it.
An orphaned `running` receipt is displayed as `outcome_unknown`; start a new
drill with a new ID only after inspecting the prior target. No automatic retry,
overwrite, cleanup, server access or production rollout is performed.

RTO covers verification, restoration and all canaries. RPO is the largest lag
from the specified incident time to the database marker or any declared
component recovery point. Receipts identify the source-manifest hash, target,
checks, budgets, durations and backup method, never credentials or row data.
Production readiness still requires running a real approved snapshot and
retaining the signed evidence; synthetic fixtures do not establish its RPO/RTO.

## Reproducible Local Acceptance

The test harness uses only an explicitly selected local Docker socket. It creates
synthetic source databases, real pgBackRest backups/WAL, an object file, encrypted
runtime secrets and an authenticated Edge function. It runs both restore methods
without network access and checks signed receipts, tenant RLS, queues, business
data, function authorization and recovery markers. The PITR case also checks that
a transaction committed after the target time is absent. Both cases reject a
duplicate drill ID without changing its receipt, and reject a corrupted object
before database restoration.

With Edge Runtime dependencies installed locally, use a Linux Bun binary matching
the test image's architecture and libc. The test image must contain PostgreSQL 18,
pgBackRest and a `postgres` user:

```sh
bun --no-env-file scripts/test-project-restore-drill.ts \
  <local-postgres-pgbackrest-image> <absolute-linux-bun-path> <local-docker-context>
```

The command prints its private artifact directory and measured results, retains
signed receipts and synthetic snapshots there, and removes only the containers
and volume it created. Test keys are synthetic and must never be used outside
these fixtures. The operator runner is executed from TypeScript with Bun, not as
a standalone compiled executable.

Local acceptance on September 8, 2026 used PostgreSQL 18, pgBackRest 2.58.0
and Bun 1.4.0 in isolated Linux ARM64 containers. Both restore methods passed;
the logical case verified eight checks and the PITR case verified nine.
Durations are synthetic fixture measurements, not production recovery guarantees.
The documented operational image still requires its own build, digest pinning
and approved production-snapshot acceptance.
