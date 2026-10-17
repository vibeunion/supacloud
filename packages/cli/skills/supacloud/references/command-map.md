# SupaCloud CLI command map

Load this reference when selecting a command surface or when a user asks an AI to “just change the database.”

## Decision table

| Intent | Use | Guardrail |
| --- | --- | --- |
| Deploy the bound application | `supacloud --env <name> deploy` | Use current CLI/server and application delivery configuration; never fall back to standalone target or direct frontend activation commands |
| Inspect current project binding | `supacloud status` | Read-only; run first |
| Inspect selected project API/Auth/Studio origins | `supacloud project endpoints` | Uses the Management API's authoritative projection; do not reconstruct domains locally |
| Enumerate projects or endpoint projections | `supacloud-admin project list` / `project list_endpoints` | Platform-wide read; never promote a project credential to Admin authority |
| Inspect project health/logs/tasks | `project`, `queue`, `task_events`, `diagnostics` | Prefer bounded reads |
| Read database rows or metadata | `database query` and database inspection actions | `SELECT`/read-only by default |
| Create schema/function/RPC/trigger/RLS/index/grant/extension | `supabase migration_new`, then edit SQL | Never direct remote DDL |
| Generate migration from local schema changes | `supabase db_diff` | Review generated SQL before use |
| Generate migration from declarative SQL | `supabase db_schema_declarative_sync` | Defaults to no-apply; preserve an existing Drizzle/schema authority |
| Capture declarative schema files | `supabase db_schema_declarative_generate` | Explicit DSN or upstream linked project; overwrite requires approval |
| Pull official Supabase configuration | `supabase config_pull` | Preview by default; local write requires `dry_run=false` and `yes`; not SupaCloud settings |
| Run the official local stack | `supabase stack_start`, `stack_prepare`, `stack_status`, `stack_stop` | Docker default; native alpha requires `SUPACLOUD_ENABLE_NATIVE_STACK=1` |
| Remove the official local stack | `supabase stack_destroy` | Local data loss; requires `confirm_destroy` and `yes` |
| Capture Lite drift | `lite db_diff`, `lite db_pull` | Draft outside migrations; only reviewed already-present DDL may use `baseline` |
| Rebuild local database | `supabase db_reset` | Local only; preserve required seed behavior |
| Inspect or back up a remote database | `supabase db_pull`, `migration_list`, `db_dump`, `gen_types` | Requires explicit PostgreSQL DSN; redact it |
| Replay the release-canary fixture stage receipt | `release release_canary_fixture_stage_replay` | Dual-bind Management project context and that project's service-role application origin; accepts only the exact subject/request UUID pair and a strict idempotent receipt |
| Disable a staged release-canary fixture | `release release_canary_fixture_disable_replay` | Uses the fixed disable RPC once, accepts idempotent false/true receipts, then queries the existing pending RPC with issuer/subject and requires authoritative JSON `false`; fixture binding comes from the strict disable receipt |
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
- `supabase`: allowlisted official CLI adapter for initialization, declarative authoring, config pull, local stacks, reset/diff, explicit-DSN inspection/backup/type generation, and SupaCloud-controlled migration push.
- `lite`: local-only Lite runtime, schema authoring and snapshot operations; never reinterpret PGlite state as a Postgres DSN.
- `auth`: provider/configuration plus bounded user lookup and production-confirmed `magiclink`, `recovery`, or `invite` generation. Search/email/redirect inputs and returned action URLs are bounded and validated before use.
- `storage`: buckets and object-management workflows.
- `edge_functions`: list, atomically read one active or deleted identity with `get_config`, read immutable source, deploy, activate, configure, and delete Edge Functions. For every mutation, pass the `activation_id` read from the same `list` or `get_config` snapshot as `--expected-activation-id`; use `legacy` only for a never-created or listed legacy Function, not for a deleted slug with a tombstone UUID. Deploy and activate actions also require the non-negative observed version as `--expected-active-version`; use `absent` for a never-created slug or a `get_config` tombstone. Version `0` is a legacy version token and cannot be used as a source or activation target.
- `frontend`: hosting management, release inspection and operator rollback. Publishing uses `supacloud deploy`; `deploy_git`, `deploy_upload`, `redeploy`, `upload_release` and `activate_release` are removed.
- `secrets`: project secret management; never print values after write.
- `queue`, `task_events`, `diagnostics`: asynchronous workload operations and bounded diagnostics.
- `gateway`: project route/config/rebuild operations.
- `release`: explicit backup/PostgREST maintenance and release-canary replay diagnostics. Do not run these or generate release scopes as prerequisites for `supacloud --env <name> deploy`; the platform owns deployment orchestration.
- `ai`: inspect or install this packaged Skill.

## Safe inspection pattern

```bash
supacloud status
supacloud project get
supacloud project endpoints
supacloud project health
supacloud supabase migration_list --db_url "$SUPACLOUD_DB_URL"
```

The endpoint projection returns bounded, credential-free API/Auth/Studio origins,
canonical hosts, URL schemes, configuration sources, and API aliases. It does
not assert DNS, certificate, or runtime readiness; use the relevant health and
gateway inspection commands for those checks.

Do not paste the DSN value into chat or commit it to shell scripts. Prefer an environment variable supplied outside the repository.
