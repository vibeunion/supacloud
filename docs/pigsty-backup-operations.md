# Pigsty Backup Operations

[English](pigsty-backup-operations.md) | [简体中文](pigsty-backup-operations.zh-CN.md)

SupaCloud uses Pigsty's PostgreSQL backup substrate. The platform does not
replace pgBackRest or `pig pitr`; it validates their state and records the
result as a SupaCloud readiness contract.

## Provider Responsibilities

Pigsty/pgBackRest owns:

- PostgreSQL physical full, differential, and incremental backups
- WAL archiving and point-in-time recovery
- Repository configuration and retention
- Patroni coordination during cluster recovery

SupaCloud owns:

- fail-closed availability checks
- tenant/project API authorization
- backup and restore receipts
- component health read-back after recovery
- object storage, secrets, runtime metadata, and tenant isolation checks

## Configuration

The installer persists these values in `/etc/supabase/install.env` or the
Management API environment:

```text
SUPACLOUD_PGBACKREST_CONFIG=/etc/supabase/pgbackrest.conf
SUPACLOUD_PGBACKREST_STANZA=db-main
SUPACLOUD_PGBACKREST_USER=postgres
SUPACLOUD_PGBACKREST_BIN=pgbackrest
SUPACLOUD_PITR_ENABLED=true
```

The configuration must point to the Pigsty-managed repository. A successful
local PostgreSQL process is not evidence that a backup repository is usable.

## Readiness Check

Run on the management host:

```bash
sudo /usr/local/libexec/supacloud/backup_manager.sh verify
```

The command emits one JSON readiness record with:

- `schema`
- `provider`
- `stanza`
- `repository_count`
- `completed_backup_count`
- `latest_completed_backup`

It exits non-zero when pgBackRest is missing, the stanza is unhealthy, the
repository status disagrees with the stanza status, or the inventory cannot be
read. It never converts an unavailable provider into an empty backup list.

For a release or upgrade gate, also run the deterministic SupaCloud acceptance
checker:

```bash
bun scripts/verify-pigsty-backup-acceptance.ts --max-age-seconds 86400
```

The checker requires a ready provider, at least one repository, and a fresh
completed backup. Without a target host and a real pgBackRest read-back, an
`--input` fixture only tests the document contract; it is not production
recovery evidence.

## Backup And PITR

```bash
sudo /usr/local/libexec/supacloud/backup_manager.sh create db-main full
sudo /usr/local/libexec/supacloud/backup_manager.sh create db-main incr
sudo /usr/local/libexec/supacloud/backup_manager.sh restore \
  2026-09-06T12:30:00Z
```

`create` validates the pgBackRest inventory after the command returns.
`restore` requires `SUPACLOUD_PITR_ENABLED=true`, uses Pigsty's `pig pitr`, and
returns success only after the command exits successfully.

For normal production use, prefer the authenticated Management API:

- `GET /v1/projects/:ref/database/backups`
- `POST /v1/projects/:ref/database/backups`
- `POST /v1/platform/backups/restore`

The Management API additionally applies project/admin authorization,
confirmation strings, concurrent-restore protection, and structured error
responses.

## Enterprise Recovery Drill

Pigsty backup readiness is only the database-layer gate. A complete SupaCloud
recovery drill must also:

1. Verify the selected backup from an independent repository location.
2. Restore the database and record the actual recovery timestamp.
3. Restore the project's object storage and runtime metadata.
4. Reconcile migrations and component versions.
5. Verify Management API, Caddy, PostgREST, GoTrue, Edge Runtime, Realtime,
   and pgredis health.
6. Verify authenticated access and cross-tenant denial.
7. Record measured RPO, RTO, backup identity, and unresolved deviations.

`pgbackrest info` success, a healthy Patroni leader, or a successful database
PITR alone is not a complete SupaCloud recovery acceptance.
