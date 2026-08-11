# SupaCloud CLI command map

Load this reference when selecting a command surface or when a user asks an AI to “just change the database.”

## Decision table

| Intent | Use | Guardrail |
| --- | --- | --- |
| Inspect current project binding | `supacloud-cli status` | Read-only; run first |
| Inspect project health/logs/tasks | `project`, `queue`, `task_events`, `diagnostics` | Prefer bounded reads |
| Read database rows or metadata | `database query` and database inspection actions | `SELECT`/read-only by default |
| Create schema/function/RPC/trigger/RLS/index/grant/extension | `supabase migration_new`, then edit SQL | Never direct remote DDL |
| Generate migration from local schema changes | `supabase db_diff` | Review generated SQL before use |
| Rebuild local database | `supabase db_reset` | Local only; preserve required seed behavior |
| Inspect or back up a remote database | `supabase db_pull`, `migration_list`, `db_dump`, `gen_types` | Requires explicit PostgreSQL DSN; redact it |
| Preview/apply migrations remotely | `supabase push` | Always dry-run first; production needs explicit approval |
| Mark proven-equivalent historical migrations as applied | `database baseline_migrations` | Dry-run, schema-equivalence proof, backup, explicit approval |
| Manage Auth/Storage/Edge Functions/frontend/secrets | Corresponding project module | Keep deployable config/code in version control |
| Configure project gateway routes | `gateway` | Requires an admin-capable project token; inspect before write |
| Install/upgrade/debug SupaCloud servers | `supacloud-admin` | Platform boundary; not a project CLI action |

If `status` reports missing project context, local migration authoring may still
continue. Do not attempt remote inspection, baseline, push, or resource changes
until a project-scoped context is resolved.

## Command groups

- `status`: resolved context, Management API connectivity, authentication, and project reachability.
- `project`: project metadata, health, logs, API keys/settings, background tasks, retry/cancel, DLQ, and background settings.
- `database`: read/query, schema inspection, extensions, indexes, RLS, stats, migration push, controlled historical baseline, and SQL-file execution.
- `supabase`: allowlisted official CLI adapter for migration authoring, local reset/diff, explicit-DSN inspection/backup/type generation, and SupaCloud-controlled migration push.
- `auth`: provider and authentication configuration.
- `storage`: buckets and object-management workflows.
- `edge_functions`: list, read immutable source, deploy, activate, and configure Edge Functions. Pass the positive version read from `list` to `source --version` and as `--expected-active-version`; use `absent` only for a new slug. Version `0` is internal-only.
- `frontend`: list, build/deploy, domain, and deployment workflows.
- `secrets`: project secret management; never print values after write.
- `queue`, `task_events`, `diagnostics`: asynchronous workload operations and bounded diagnostics.
- `gateway`: project route/config/rebuild operations.
- `ai`: inspect or install this packaged Skill.

## Safe inspection pattern

```bash
supacloud-cli status
supacloud-cli project get
supacloud-cli project health
supacloud-cli supabase migration_list --db_url "$SUPACLOUD_DB_URL"
```

Do not paste the DSN value into chat or commit it to shell scripts. Prefer an environment variable supplied outside the repository.
