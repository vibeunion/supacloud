# Database migration and drift workflow

Migration files are the durable source of truth. `supabase_migrations.schema_migrations` records what the controlled migration path applied; it does not discover console/`psql` changes and does not reconstruct the current schema.

## New changes

1. Inspect the repository, existing migrations, migration history, and relevant schema.
2. Create a migration:

   ```bash
   supacloud-cli supabase migration_new --name <intent>
   ```

3. Put tables, views, functions/RPC, triggers, RLS, indexes, grants, extensions, and required reference data in the generated SQL file.
4. Make migrations deterministic and reviewable:
   - qualify schemas;
   - avoid environment-specific IDs, domains, and secrets;
   - use transactions when the operation supports them;
   - document destructive statements and rollback strategy;
   - avoid modifying an already-applied migration.
5. Rebuild locally and run application tests:

   ```bash
   supacloud-cli supabase db_reset --no_seed
   ```

6. Preview remote application:

   ```bash
   supacloud-cli supabase push --ref <project-ref> --dir supabase/migrations --dry_run
   ```

7. After explicit environment approval, apply and read back migration history.

## Previously changed remote database

Do not fabricate old migration files and immediately push them. Reconcile deliberately:

1. Freeze direct SQL/dashboard writes for the reconciliation window.
2. Inventory three states separately:
   - version-controlled migration files;
   - remote migration-history rows;
   - actual remote schema/functions/policies/grants.
3. Create a schema-only backup before changing tracking or schema:

   ```bash
   supacloud-cli supabase db_dump \
     --db_url "$SUPACLOUD_DB_URL" \
     --file backups/pre-reconcile-schema.sql
   ```

4. In an isolated branch/worktree, pull the actual remote schema:

   ```bash
   supacloud-cli supabase db_pull \
     --db_url "$SUPACLOUD_DB_URL" \
     --declarative \
     --name remote_baseline
   ```

5. Review the generated artifacts. Remove ownership, secret, environment-specific, and extension noise that should not be portable.
6. Choose one strategy:
   - Empty/new migration repository: establish a reviewed baseline representing the current remote schema.
   - Existing migration repository: keep applied migrations immutable and add one reconciliation migration for the verified delta.
7. Prove the chosen migration set can recreate the desired schema from a clean local database. Compare the recreated schema with the captured remote schema.
8. Only after equivalence is proven, preview the controlled baseline action:

   ```bash
   supacloud-cli database baseline_migrations \
     --ref <project-ref> \
     --dir supabase/migrations \
     --dry_run
   ```

9. Review every file listed under `Would mark as applied`. Obtain explicit approval, then rerun without `--dry_run`. This action records the selected local migration files through the SupaCloud migration-mode API; it does not execute their DDL.
10. Never insert/update/delete `supabase_migrations.schema_migrations` via `database query`. If the controlled baseline action cannot represent the verified state, stop and request operator assistance.
11. Run `supabase push --dry_run`; it should report no unintended pending historical migration. Read back migration history and affected objects.

## Functions, triggers, RLS, and grants

These are schema objects even when business logic lives inside them. Keep them in migrations:

- `CREATE OR REPLACE FUNCTION ...`
- trigger creation/removal;
- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`;
- `CREATE POLICY` / `ALTER POLICY` / `DROP POLICY`;
- role grants and default privileges;
- extension enablement and version changes.

For function replacement, verify signature, volatility, security definer/invoker behavior, `search_path`, ownership, grants, and callers. A function body diff without its security attributes is incomplete.

## Backups and rollback

- Schema backup: `supabase db_dump` with the default schema mode.
- Data backup: use an approved data-backup path; do not assume schema dump includes application data.
- Restore testing: prove the backup can be parsed/restored in an isolated database before relying on it.
- Destructive migrations: prefer expand-contract rollout, record affected rows, and provide reversal or forward-fix SQL.
- Migration history is not a backup. Keep backups outside the migration directory and exclude credentials from filenames/content.

## Break-glass

A direct remote write is acceptable only when waiting for the normal migration pipeline would cause greater harm and the user explicitly authorizes it. Before execution:

1. record incident scope and exact target;
2. take a relevant backup;
3. prepare bounded SQL plus rollback SQL;
4. show the SQL without secrets;
5. receive explicit approval;
6. execute once and read back;
7. create the equivalent migration immediately so repository truth matches production.

If any item is missing, stop instead of improvising a direct write.
