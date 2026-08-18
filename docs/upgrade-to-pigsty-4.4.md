# Upgrade to Pigsty 4.4

> Historical migration guide. SupaCloud now defaults to Pigsty v4.5.0; see [Upgrade to Pigsty 4.5](./upgrade-to-pigsty-4.5.md) for the current version pin and operational checklist.

This guide upgrades an existing SupaCloud installation to Pigsty v4.4 and applies the Supabase compatibility migrations introduced with that release.

## What changes

- Logflare Analytics moves to the dedicated `_supabase` database and `_analytics` schema.
- Each active project database receives Studio-compatible `extensions.pg_stat_statements` wrappers.
- Project metadata receives opaque Publishable/Secret API keys while legacy `anon` and `service_role` JWT keys remain supported.
- Opaque key rotation is independent from `JWT_SECRET`, so it does not invalidate existing user sessions.

## Before upgrading

Back up PostgreSQL, `/etc/supabase`, the current Pigsty configuration, and the Analytics schema. Ensure the latest SupaCloud management binary is installed before the compatibility step so Secret Keys can be encrypted during backfill.

## Recommended upgrade

```bash
cd /path/to/supacloud
bash scripts/upgrade_pigsty.sh
```

The script first migrates legacy Analytics while the old stack is still in place, then downloads Pigsty v4.4.0, reapplies the `supabase` template, runs the Pigsty playbook, and invokes the remaining compatibility migrations. This ordering prevents the new Logflare instance from creating a non-empty destination before legacy data is copied.

Override the Pigsty release only when intentionally testing another version:

```bash
PIGSTY_VERSION=v4.4.0 bash scripts/upgrade_pigsty.sh
```

## Run the compatibility migration separately

The migration is idempotent and supports a read-only preview and check:

```bash
sudo bash scripts/upgrade_pigsty_4_4_compat.sh --dry-run
sudo bash scripts/upgrade_pigsty_4_4_compat.sh --prepare-analytics
sudo bash scripts/upgrade_pigsty_4_4_compat.sh --apply
sudo bash scripts/upgrade_pigsty_4_4_compat.sh --check
```

`--prepare-analytics` stops the legacy compose `analytics` service before taking the migration snapshot, writes the destination environment, and recreates the service against `_supabase._analytics`. If preparation fails before the data transaction commits, it restarts the legacy service. If data has committed, it only recreates the service when the environment safely targets the migrated destination; otherwise it leaves the writer stopped to avoid split-brain data. The full upgrade script recreates Analytics with the current environment if a later Pigsty step fails. If the service is managed outside the detected Pigsty compose project, stop it yourself and set `SUPACLOUD_ASSUME_ANALYTICS_STOPPED=true` only after verifying it is no longer writing.

It performs these operations:

1. Creates `_supabase` and `_analytics` when absent.
2. Migrates an existing non-empty `postgres._analytics` schema in one transaction before Pigsty 4.4 starts Logflare, and records a completion marker. A non-empty unmarked destination fails closed instead of being overwritten.
3. Repairs Studio `pg_stat_statements` compatibility objects in `postgres` and active project databases.
4. Adds opaque-key metadata columns and runs `supacloud --init-db` to backfill encrypted keys.
5. Updates the Pigsty Supabase environment to point Logflare at `_supabase`.

The check fails if active projects still have incomplete opaque-key metadata.
When legacy `postgres._analytics` contains data, `--apply` fails closed until `--prepare-analytics` has completed; this prevents an online copy while Logflare is still writing.

## Rollback guidance

```bash
bash scripts/upgrade_pigsty_4_4_compat.sh --rollback-plan
```

Rollback output is advisory. The script never automatically drops the Analytics database or key metadata columns. Preserve those columns when temporarily running an older SupaCloud binary; older versions ignore them.

Legacy Pigsty Supabase compose cleanup is not part of this upgrade. If the host still runs the historical compose stack, migrate it explicitly only after verifying the per-project `supacloud-pgrst@*` and `supacloud-gotrue@*` services.

## Storage note

SupaCloud defaults to `S3_STORAGE_TYPE=juicefs`. The Pigsty upgrade must preserve that setting and must not re-enable historical Garage storage paths.
