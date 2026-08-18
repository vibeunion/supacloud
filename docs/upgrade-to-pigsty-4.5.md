# Upgrade to Pigsty 4.5

SupaCloud pins **Pigsty v4.5.0** for fresh installations and for the default native-infrastructure upgrade path. The pin is exact and does not follow a moving `latest` reference.

Upstream reference: [Pigsty v4.5.0 tag](https://github.com/pgsty/pigsty/tree/v4.5.0).

Upstream Pigsty v4.5.0 identifies PostgreSQL 18.6 as its current PostgreSQL 18 baseline and publishes a catalog of 575 extensions. SupaCloud continues to use `PG_VERSION=18` and Pigsty's official `supabase` configuration template.

## Scope of this upgrade

- Changes every SupaCloud installer default from `v4.4.0` to `v4.5.0`.
- Keeps SupaCloud-owned Caddy, VictoriaLogs, tenant runtimes, and storage behavior unchanged.
- Continues to run the historical `upgrade_pigsty_4_4_compat.sh` migration idempotently. Its file name and migration identifiers intentionally remain unchanged because they describe the release that introduced those database changes.
- Does not enable the legacy Pigsty Supabase Compose application stack unless an operator explicitly opts into that historical path.

## Before upgrading

1. Back up PostgreSQL and verify the backup is readable.
2. Back up `/etc/supabase` and the current `~/pigsty/pigsty.yml`.
3. Confirm there are no failed tenant migrations or unresolved PostgreSQL health alerts.
4. Keep enough disk space for the Pigsty source, package metadata, and a configuration backup.

The upgrade script also writes a timestamped `pigsty.yml.supabackup.*` file before re-running Pigsty configuration.

## Recommended upgrade

From a current SupaCloud checkout:

```bash
cd /path/to/supacloud
bash scripts/upgrade_pigsty.sh
```

The default is now `v4.5.0`. To make the target explicit in automation:

```bash
PIGSTY_VERSION=v4.5.0 bash scripts/upgrade_pigsty.sh
```

The script downloads the exact Pigsty tag, regenerates the `supabase` template, restores SupaCloud-specific settings, applies Pigsty, and then runs the idempotent Supabase compatibility checks.

A persisted `/etc/supabase/install.env` from an older installation may still contain `PIGSTY_VERSION=v4.4.0`. That file remains operator-owned and is not silently rewritten during an infrastructure upgrade. Use the explicit command above for an existing host, and update the persisted value only after validating the host.

## Historical 4.4 compatibility migration

Pigsty 4.4 introduced Supabase-specific Analytics, Studio, opaque-key, tenant-authenticator, PgBouncer, and monitor-role compatibility work. SupaCloud preserves those migration markers so an already-upgraded host is not treated as new.

Read-only verification:

```bash
sudo bash scripts/upgrade_pigsty_4_4_compat.sh --check
```

For a host that never completed the historical migration, follow [Upgrade to Pigsty 4.4](./upgrade-to-pigsty-4.4.md) before or as part of the 4.5 upgrade.

## Verification

```bash
# Repository defaults
rg -n 'PIGSTY_VERSION.*v4\.5\.0' config.env install.sh scripts packages/management-api/src/install.ts

# Shell syntax
bash -n install.sh scripts/upgrade_pigsty.sh scripts/upgrade_pigsty_4_4_compat.sh scripts/lib/install_config.sh

# Compatibility state
sudo bash scripts/upgrade_pigsty_4_4_compat.sh --check

# Host health
systemctl --failed
sudo -u postgres psql -Atqc 'select version();'
```

Also verify the Management API, project PostgREST/GoTrue services, Caddy routes, Grafana, backups, and at least one project SDK request.

## Rollback

If Pigsty application fails before the upgrade completes, restore the timestamped `pigsty.yml.supabackup.*` file and the host backup before reapplying the previous infrastructure version. To intentionally return the source baseline to Pigsty 4.4:

```bash
PIGSTY_VERSION=v4.4.0 bash scripts/upgrade_pigsty.sh
```

Do not drop the historical compatibility tables, opaque-key columns, or Analytics destination during a source rollback. Older SupaCloud binaries ignore additive metadata, while deleting it can make a later retry unsafe.
