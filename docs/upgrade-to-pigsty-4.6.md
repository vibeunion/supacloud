# Upgrade to Pigsty 4.6

SupaCloud pins **Pigsty v4.6.0** for fresh installations and for the default native-infrastructure upgrade path. The pin is exact and does not follow a moving `latest` reference.

Upstream reference: [Pigsty v4.6.0 tag](https://github.com/pgsty/pigsty/tree/v4.6.0).

Upstream Pigsty v4.6.0 (released 2026-11-13) identifies PostgreSQL **18.7** as its current PostgreSQL 18 baseline and publishes a catalog of **625** extensions (52 added, 2 removed). SupaCloud continues to use `PG_VERSION=18` and Pigsty's official `supabase` configuration template.

## Scope of this upgrade

- Changes every SupaCloud installer default from `v4.5.0` to `v4.6.0`.
- Keeps SupaCloud-owned Caddy, VictoriaLogs, tenant runtimes, and storage behavior unchanged.
- Continues to run the historical `upgrade_pigsty_4_4_compat.sh` migration idempotently. Its file name and migration identifiers intentionally remain unchanged because they describe the release that introduced those database changes.
- Does not change `PG_VERSION`. PostgreSQL 19 is **not** part of this upgrade; see [PostgreSQL 19 readiness](#postgresql-19-readiness).
- Does not enable the legacy Pigsty Supabase Compose application stack unless an operator explicitly opts into that historical path.

## Upstream changes to review

Comparing `conf/supabase.yml` at `v4.5.0` and `v4.6.0`, four changes affect a SupaCloud host:

| Upstream change | Why it matters |
| --- | --- |
| `pg_extensions` catalog and package set move to 625 entries, pgrx **0.19.3**, PostGIS **3.7.0**, pgvector **0.8.7**, TimescaleDB **2.31.0**, DocumentDB **1.0** | Existing tenant databases keep their installed extension versions until an explicit `ALTER EXTENSION ... UPDATE`. Read back `extversion` for `postgis`, `vector`, `pgmq`, `pg_net`, `supautils`, `pgsodium`, `vault`, and `wrappers` after the playbook run. |
| `supabase_etl_admin` gains `bypassrls: true` | The ETL login role now bypasses row-level security cluster-wide. Review every grant to that role before applying; SupaCloud does not rely on RLS for ETL, and PostgREST/RPC paths must not run as it. |
| The `postgres` database gains `app.settings.jwt_exp: 3600` | Additive GUC used by the legacy Supabase stack. SupaCloud does not read it; keep the Management API's own JWT expiry settings authoritative. |
| Docker-network `pg_hba` rules widen from `172.17.0.0/16` to `172.16.0.0/12` for `postgres` and `_supabase` | This is the largest trust change in the release. `172.16.0.0/12` covers `172.16`–`172.31`, so password authentication to `postgres` and `_supabase` is now accepted from far more private addresses. If `SUPACLOUD_INSTALL_LEGACY_SUPABASE_STACK` is `false` (the default), remove or narrow those two rules before applying, and keep tenant HBA pairing (`ensure_pigsty_tenant_hba_rule`) as the control that actually scopes tenant logins. |

The template also refreshes its demo JWT material (new `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, issuer `supabase`, five-year expiry) and adds `API_GW_HTTP_PORT: 8000` for the legacy app. The installer still overwrites all three values from its own generated credentials, but a host that only re-runs `./configure -c supabase` without the SupaCloud patch step would adopt the demo keys. Always upgrade through `scripts/upgrade_pigsty.sh`.

## PostgreSQL 19 readiness

PostgreSQL 19.0 exists in PGDG, and `pg_cron`, `pgaudit`, `http`, `pgvector`, `postgis-3`, `hypopg`, `pg_stat_kcache`, `pgtap`, `plpgsql_check`, and `wal2json` already publish `postgresql-19-*` packages. SupaCloud still cannot move to PostgreSQL 19 because these required pieces have no PG19 build:

- Pigsty package repository: no `postgresql-19-*` packages at all, which blocks `pgmq`, `pg_net`, `pg_jsonschema`, `pgsodium`, `supautils`, `supabase_vault`, `wrappers`, `index_advisor`, `pg_plan_filter`, and `documentdb`.
- Supabase `pg_graphql`: newest release (v1.6.3) ships `pg14`–`pg18` only.
- Microsoft `pg_durable`: newest release (v0.2.9) ships `postgresql-17`/`postgresql-18` only. It is a `shared_preload_libraries` extension, so it cannot be dropped to unblock an upgrade.

Treat PostgreSQL 19 as blocked until all three publish a PG19 artifact.

## Before upgrading

1. Back up PostgreSQL and verify the backup is readable.
2. Back up `/etc/supabase` and the current `~/pigsty/pigsty.yml`.
3. Confirm there are no failed tenant migrations or unresolved PostgreSQL health alerts.
4. Keep enough disk space for the Pigsty source, package metadata, and a configuration backup.

The backup command and the backup acceptance contract are separate gates. Before
changing the host, run `backup_manager.sh verify` and then:

```bash
bun scripts/verify-pigsty-backup-acceptance.ts --max-age-seconds 86400
```

An `incomplete` result blocks the upgrade. A JSON fixture passed with `--input`
only checks the contract and does not establish that the host repository or PITR
path works.

The upgrade script also writes a timestamped `pigsty.yml.supabackup.*` file before re-running Pigsty configuration.

## Recommended upgrade

From a current SupaCloud checkout:

```bash
cd /path/to/supacloud
bash scripts/upgrade_pigsty.sh
```

The default is now `v4.6.0`. To make the target explicit in automation:

```bash
PIGSTY_VERSION=v4.6.0 bash scripts/upgrade_pigsty.sh
```

The script downloads the exact Pigsty tag, regenerates the `supabase` template, restores SupaCloud-specific settings, applies Pigsty, and then runs the idempotent Supabase compatibility checks.

A persisted `/etc/supabase/install.env` from an older installation may still contain `PIGSTY_VERSION=v4.5.0` or older. That file remains operator-owned and is not silently rewritten during an infrastructure upgrade. Use the explicit command above for an existing host, and update the persisted value only after validating the host.

## Verification

```bash
# Repository defaults
rg -n 'PIGSTY_VERSION.*v4\.6\.0' config.env install.sh scripts packages/management-api/src/install.ts

# Shell syntax
bash -n install.sh scripts/upgrade_pigsty.sh scripts/upgrade_pigsty_4_4_compat.sh scripts/lib/install_config.sh

# Compatibility state
sudo bash scripts/upgrade_pigsty_4_4_compat.sh --check

# Fail-closed host upgrade gate (requires the target Pigsty host)
sudo bash scripts/verify-pigsty-upgrade-acceptance.sh

# Host health and catalog state
systemctl --failed
sudo -u postgres psql -Atqc 'select version();'
sudo -u postgres psql -Atqc "select extname, extversion from pg_extension order by 1;"
sudo -u postgres psql -Atqc "select distinct datname from pg_database where datname like 'supa\_%';"
```

Also verify the Management API, project PostgREST/GoTrue services, Caddy routes, Grafana, backups, and at least one project SDK request. Re-check `pg_hba.conf` for leftover `172.16.0.0/12` rules and for the re-applied tenant `samerole` + reject pairing.

For a production claim, also retain a signed isolated restore receipt from
[`scripts/test-project-restore-drill.ts`](../scripts/test-project-restore-drill.ts)
using an approved snapshot. The local Docker restore drill and the backup
readiness check are useful gates, but neither is production evidence until the
target host and approved snapshot have been exercised.

## Rollback

If Pigsty application fails before the upgrade completes, restore the timestamped `pigsty.yml.supabackup.*` file and the host backup before reapplying the previous infrastructure version. To intentionally return the source baseline to Pigsty 4.5:

```bash
PIGSTY_VERSION=v4.5.0 bash scripts/upgrade_pigsty.sh
```

Do not drop the historical compatibility tables, opaque-key columns, or Analytics destination during a source rollback. Older SupaCloud binaries ignore additive metadata, while deleting it can make a later retry unsafe. Extension version changes are forward-only for each tenant database: a rollback of the Pigsty package set does not downgrade an extension that was already updated.