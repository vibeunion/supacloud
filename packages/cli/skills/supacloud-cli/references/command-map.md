# SupaCloud CLI command map

Load this reference when selecting a command surface or when a user asks an AI to “just change the database.”

## Decision table

| Intent | Use | Guardrail |
| --- | --- | --- |
| Inspect current project binding | `supacloud-cli status` | Read-only; run first |
| Inspect selected project API/Auth/Studio origins | `supacloud-cli project endpoints` | Uses the Management API's authoritative projection; do not reconstruct domains locally |
| Enumerate projects or endpoint projections | `supacloud-admin project list` / `project list_endpoints` | Platform-wide read; never promote a project credential to Admin authority |
| Inspect project health/logs/tasks | `project`, `queue`, `task_events`, `diagnostics` | Prefer bounded reads |
| Read database rows or metadata | `database query` and database inspection actions | `SELECT`/read-only by default |
| Create schema/function/RPC/trigger/RLS/index/grant/extension | `supabase migration_new`, then edit SQL | Never direct remote DDL |
| Generate migration from local schema changes | `supabase db_diff` | Review generated SQL before use |
| Rebuild local database | `supabase db_reset` | Local only; preserve required seed behavior |
| Inspect or back up a remote database | `supabase db_pull`, `migration_list`, `db_dump`, `gen_types` | Requires explicit PostgreSQL DSN; redact it |
| Preview/apply migrations remotely | `supabase push` | Always dry-run first; production needs explicit approval |
| Mark proven-equivalent historical migrations as applied | `database baseline_migrations` | Dry-run, schema-equivalence proof, backup, explicit approval |
| Inspect auth users or generate a controlled login link | `auth list_users`, `auth get_user`, `auth generate_link` | User reads are bounded; generation supports only `magiclink`, `recovery`, and `invite`, requires production confirmation, and returns only a validated action URL |
| Manage Auth/Storage/Edge Functions/frontend/secrets | Corresponding project module | Keep deployable config/code in version control |
| Configure project gateway routes | `gateway` | Requires an admin-capable project token; inspect before write |
| Install/upgrade/debug SupaCloud servers | `supacloud-admin` | Platform boundary; not a project CLI action |

If `status` reports missing project context, local migration authoring may still
continue. Do not attempt remote inspection, baseline, push, or resource changes
until a project-scoped context is resolved.

## Command groups

- `status`: resolved context, Management API connectivity, authentication, and project reachability.
- `project`: selected-project metadata, authoritative endpoint projection, health, logs, API keys/settings, background tasks, retry/cancel, DLQ, and background settings. `project list` deliberately redirects to `supacloud-admin`; cross-project enumeration is not a project CLI capability.
- `database`: read/query, schema inspection, extensions, indexes, RLS, stats, migration push, controlled historical baseline, and SQL-file execution.
- `supabase`: allowlisted official CLI adapter for migration authoring, local reset/diff, explicit-DSN inspection/backup/type generation, and SupaCloud-controlled migration push.
- `auth`: provider/configuration plus bounded user lookup and production-confirmed `magiclink`, `recovery`, or `invite` generation. Search/email/redirect inputs and returned action URLs are bounded and validated before use.
- `storage`: buckets and object-management workflows.
- `edge_functions`: list, atomically read one active or deleted identity with `get_config`, read immutable source, deploy, activate, configure, and delete Edge Functions. For every mutation, pass the `activation_id` read from the same `list` or `get_config` snapshot as `--expected-activation-id`; use `legacy` only for a never-created or listed legacy Function, not for a deleted slug with a tombstone UUID. Deploy and activate actions also require the non-negative observed version as `--expected-active-version`; use `absent` for a never-created slug or a `get_config` tombstone. Version `0` is a legacy version token and cannot be used as a source or activation target.
- `frontend`: list, build/deploy, domain, and deployment workflows.
- `secrets`: project secret management; never print values after write.
- `queue`, `task_events`, `diagnostics`: asynchronous workload operations and bounded diagnostics.
- `gateway`: project route/config/rebuild operations.
- `ai`: inspect or install this packaged Skill.

## Safe inspection pattern

```bash
supacloud-cli status
supacloud-cli project get
supacloud-cli project endpoints
supacloud-cli project health
supacloud-cli supabase migration_list --db_url "$SUPACLOUD_DB_URL"
```

The endpoint projection returns bounded, credential-free API/Auth/Studio origins,
canonical hosts, URL schemes, configuration sources, and API aliases. It does
not assert DNS, certificate, or runtime readiness; use the relevant health and
gateway inspection commands for those checks.

Do not paste the DSN value into chat or commit it to shell scripts. Prefer an environment variable supplied outside the repository.
