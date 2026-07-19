---
name: supacloud-cli
description: Use when operating, implementing, diagnosing, deploying, or documenting a SupaCloud project through supacloud-cli, especially database schema, functions/RPC, triggers, RLS, indexes, grants, extensions, migrations, backups, auth, storage, Edge Functions, frontend, queues, task events, diagnostics, or gateway work. Also use when an AI might otherwise call SQL, psql, a database API, or the Management API directly.
---

# SupaCloud CLI

Use `supacloud-cli` as the project-level control surface and keep durable changes reproducible from version-controlled files. Use `supacloud-admin` only for server/platform operations.

## Non-negotiable rules

1. Inspect repository state and project context before any action:

   ```bash
   git status --short --branch
   supacloud-cli status
   ```

   A missing remote project context does not block local `migration_new`, `db_diff`, or `db_reset`; it blocks remote inspection/apply until context is supplied.

2. Never place secrets, service-role keys, database URLs, passwords, or tokens in commands that will be logged, source files, migration files, or chat output.
3. Treat schema, functions/RPC, triggers, RLS policies, indexes, grants, extensions, and seed/reference-data changes as migrations. Do not apply them through `database query`, `psql`, a dashboard SQL editor, or a raw Management API call.
4. Use `database query` only for read-only inspection unless the user explicitly authorizes a documented break-glass operation. Break-glass work still requires a backup, rollback SQL, and a follow-up migration in the same task.
5. Run a remote migration dry-run before apply. Production apply requires explicit user approval in the current task.
6. Do not edit `supabase_migrations.schema_migrations` through ordinary SQL. Migration history is an application ledger, not a schema backup or source of truth. For a proven-equivalent historical baseline, use the controlled `database baseline_migrations` action with dry-run and explicit approval.
7. Service-role credentials authenticate the SupaCloud Management API. Never reinterpret them as PostgreSQL passwords or forward them to the official Supabase CLI.

## Workflow

1. Classify the request using [references/command-map.md](references/command-map.md).
2. For database work, load [references/database-workflow.md](references/database-workflow.md) and choose either new-change or historical-drift reconciliation.
3. Prefer the smallest read-only inspection that proves current state.
4. Create or update version-controlled artifacts before remote writes.
5. Verify locally, inspect the diff, and run the narrowest relevant tests.
6. Preview remote changes with `--dry_run`.
7. Apply only within the user-authorized environment and scope.
8. Read back migration history and affected resources; report exact evidence and any remaining drift.

## Database default

For a new database change:

```bash
supacloud-cli supabase migration_new --name add_accounts
# Edit the generated SQL migration.
supacloud-cli supabase db_reset --no_seed
supacloud-cli supabase push --ref <project-ref> --dir supabase/migrations --dry_run
# Apply only after explicit approval.
supacloud-cli supabase push --ref <project-ref> --dir supabase/migrations
```

Use `db_diff` as an authoring aid, not as permission to bypass review:

```bash
supacloud-cli supabase db_diff --schema public --name reconcile_public_schema
```

For a database that was previously changed directly, stop further direct writes and follow the reconciliation workflow in [references/database-workflow.md](references/database-workflow.md). Do not push guessed historical migrations against a live database. After schema equivalence is proven, preview and record the baseline through:

```bash
supacloud-cli database baseline_migrations \
  --ref <project-ref> \
  --dir supabase/migrations \
  --dry_run
```

## CLI boundaries

- `supacloud-cli`: project status, database, migrations, auth, storage, Edge Functions, frontend, queues, task events, diagnostics, and project gateway configuration.
- `supacloud-admin`: installation, upgrades, SSH diagnostics, platform-wide project lifecycle, tenant runtime, and server operations.
- Official `supabase` CLI: invoked only through the allowlisted `supacloud-cli supabase` adapter for supported local authoring or explicit-DSN inspection commands.
- Direct HTTP/SQL: read-only diagnosis or an explicitly approved break-glass path; never the default implementation path.

## Completion evidence

Before declaring success, provide:

- migration filenames and reviewed diff;
- local reset/test/typecheck evidence appropriate to the project;
- remote dry-run evidence;
- explicit approval reference for production apply;
- applied migration/read-back evidence;
- backup and rollback references for destructive or reconciliation work.
