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

## Repository Transport And PGDATA Prerequisites

Two host-level mistakes silently disable every backup while `pgbackrest` "runs"
on schedule. Check both before trusting a readiness result.

**The repository endpoint must speak the transport the configuration assumes.**
An `s3` repository with `repo1-storage-ca-file` opens TLS to the endpoint. If
port `9000` now belongs to an HTTP-only S3 gateway (for example the JuiceFS/Silo
gateway that shares `sss.pigsty:9000` with object storage), every archive and
backup fails with `[ServiceError] TLS error ... packet length too long` while
`pgbackrest info` reports `stanza: [invalid]`. Confirm the transport first:

```bash
ss -ltnp '( sport = :9000 )'
curl -s -o /dev/null -w '%{http_code}\n' http://sss.pigsty:9000/minio/health/live
openssl s_client -connect sss.pigsty:9000 -verify_return_error </dev/null
```

When the host has no TLS-terminating object store, use a local repository
instead of borrowing the object-storage port:

```yaml
pgbackrest_method: local
pgbackrest_repo:
  local:
    path: /home/pgbackrest      # a separate volume, not the PGDATA filesystem
```

Then re-render and rebuild the stanza: `ansible-playbook -i pigsty.yml
pgsql.yml -l pg-meta -t pgbackrest`, followed by `pgbackrest --stanza=<stanza>
stanza-create`, `check`, and a full backup. `archive_mode` stays `on` and
`archive_command` keeps pointing at `pgbackrest ... archive-push %p`; the
backlog drains as soon as the repository is usable.

**Every path inside PGDATA must belong to the PostgreSQL system user.**
pgBackRest reads the data directory as that user, so one root-owned leftover (a
`pg_hba.conf.bak.*` copy, a lock file, a journal) aborts the backup with
`[041] ... Permission denied`. Check and clear it before a backup window:

```bash
pgdata="$(sudo -u postgres psql -Atqc 'show data_directory')"
sudo find "$(readlink -f "$pgdata")" ! -user postgres -printf '%u:%g %m %p\n'
```

Move those files out of PGDATA rather than chowning arbitrary artifacts into
place. `scripts/verify-pigsty-upgrade-acceptance.sh` fails when any remain.

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
