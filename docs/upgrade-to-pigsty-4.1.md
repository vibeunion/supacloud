# Upgrade to Pigsty 4.3

This guide helps existing SupaCloud users upgrade the Pigsty foundation to v4.3 while preserving SupaCloud's own Caddy gateway, Edge Runtime, task, and JuiceFS-backed storage integration.

## Important Notes

**Please make sure to backup core data before performing full infrastructure updates!**

Pigsty provides powerful automated deployment tools, but major version upgrades (especially when involving core PostgreSQL version adjustments) may come with configuration changes. Please carefully assess risk time windows before proceeding.

## Upgrade Method 1: Use One-Click Upgrade Script (Recommended)

SupaCloud provides a semi-automated upgrade helper script that you can directly execute on the server terminal:

```bash
cd /path/to/supacloud
bash scripts/upgrade_pigsty.sh
```

This script will automatically:
1. Download the Pigsty v4.3 release codebase in your current user's home directory (`$HOME/pigsty`).
2. Run `./configure -c supabase` for the Pigsty foundation while keeping SupaCloud's Caddy gateway, multi-tenant runtime, storage, and Edge Function orchestration as the product-owned path.
3. Execute `ansible-playbook` to redeploy updates for each component, completing in-place upgrade.

Legacy Pigsty Supabase compose cleanup is not part of the default install or upgrade path. Operators migrating an old compose-based node must run the cleanup explicitly with `SUPACLOUD_MIGRATE_LEGACY_SUPABASE_COMPOSE=true` or `sudo bash install.sh --migrate-legacy-supabase-compose` after verifying the per-project `supacloud-pgrst@*` and `supacloud-gotrue@*` services are healthy.

## Upgrade Method 2: Manual Upgrade (Follow Official Guide)

If you maintain a large number of custom host configuration items, or wish to execute step-by-step to control update scope, it's recommended to directly follow the commands in the Pigsty official manual:

1. **Download and checkout latest code**:
   ```bash
   curl -fsSL https://repo.pigsty.io/get | bash -s v4.3.0
   cd ~/pigsty
   ```
2. **Apply reconfiguration**:
   ```bash
   ./configure -c supabase
   ```
3. **Step-by-step playbook upgrade**:
   Run playbooks individually according to the parts you need to update. For full system-wide application:
   ```bash
   ansible-playbook -i pigsty.yml install.yml
   ```

## Storage Note

SupaCloud defaults to `S3_STORAGE_TYPE=juicefs`. The Pigsty upgrade flow should preserve that default and should not re-enable historical Garage storage paths. Use `minio` or `external` only when explicitly configured.
