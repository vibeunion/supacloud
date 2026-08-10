# @supacloud/cli

Project-scoped CLI for SupaCloud users.

This package exposes only `supacloud-cli`. The bare `supacloud` name is reserved
for the compiled server binary installed at `/usr/local/bin/supacloud`.

Install:

```bash
npm install -g @supacloud/cli
supacloud-cli status
```

One-off execution:

```bash
npm exec --package @supacloud/cli -- supacloud-cli status
```

Install the packaged AI Skill:

```bash
supacloud-cli ai show_skill
supacloud-cli ai install_skill --dry_run
supacloud-cli ai install_skill
```

The default destination is `$CODEX_HOME/skills/supacloud-cli` or
`~/.codex/skills/supacloud-cli`. Use `--target /path/to/skills` for an explicit
Skill root. Different existing content is preserved unless `--force` is passed;
forced replacement creates a timestamped adjacent backup first.

The Skill directs agents to keep schema, functions/RPC, triggers, RLS, indexes,
grants, extensions, and reference-data changes in migrations; use read-only SQL
for ordinary inspection; dry-run remote migrations; and reconcile existing
remote drift before touching migration history.

`supacloud-cli` defaults to the current workspace's project context. If you do not pass explicit flags, it tries to auto-link from `.env`:

- `SUPABASE_URL` or `SUPACLOUD_API_URL`
- `SUPABASE_SERVICE_ROLE_KEY` or `SUPACLOUD_API_TOKEN`
- `SUPACLOUD_PROJECT_REF` when the project ref cannot be inferred from a managed `<ref>.api.*` hostname

Both `--key value` and `--key=value` flag syntax are accepted. `--ref` can
override the auto-linked project for an individual command. `status` checks
configuration, Management API connectivity, and authentication; it exits
non-zero when any required check fails.

Examples:

```bash
supacloud-cli status
supacloud-cli project get
supacloud-cli project logs --log_type database
supacloud-cli project task_stats
supacloud-cli project task_detail --task_id task_123
supacloud-cli queue stats --queue emails
supacloud-cli queue dlq --queue emails --limit 20
supacloud-cli task_events inspect_webhook --ref abc123
supacloud-cli database query --sql "select now()"
supacloud-cli database query --ref abc123 --file ./queries/vector-search.sql
supacloud-cli database push_migrations --ref abc123 --dir supabase/migrations --dry_run
supacloud-cli supabase migration_new --name add_accounts
supacloud-cli supabase db_diff --schema public --name add_accounts
supacloud-cli supabase push --ref abc123 --dir supabase/migrations --dry_run
supacloud-cli frontend list --ref abc123
supacloud-cli branch create --name feature-orders --data_mode schema_only
supacloud-cli branch promotion_plan --branch_ref preview123
supacloud-cli branch promote --branch_ref preview123 --plan_checksum <sha256>
supacloud-cli edge_functions deploy --ref abc123 --slug hello --path ./supabase/functions/hello
supacloud-cli edge_functions deploy_bundle --ref abc123 --slug hello --files '{"index.ts":"export default { fetch: () => new Response(\"ok\") }"}'
supacloud-cli edge_functions source --ref abc123 --slug hello --output ./hello.ts
```

`edge_functions deploy --path` bundles local TypeScript and dependencies with
Bun and runs a local syntax check before upload. The Management API validates and
normalizes the final server-side artifact against the multi-tenant Edge Runtime
module policy consistently for CLI, Web Console, and direct API deployments.
`deploy_bundle --files` accepts a JSON object in shell usage.
Use `source --output <file>` for large Functions so terminal or automation output
limits cannot truncate the original TS/JS source code. The destination must not
already exist.

Branch promotion is migration-first. `branch promotion_plan` prints pending
versions, names, statement counts, and checksums without echoing SQL into terminal
logs; review the migration files or the Web Console SQL view before approval.
`branch promote` requires the reviewed checksum, executes with the project-scoped
database role, and does not automatically copy branch data.
Use `--data_mode full_clone` only for an explicitly approved non-sensitive or
masked debugging dataset. Whole-database replacement is an administrator-only
break-glass API mode and is intentionally not exposed by this project CLI.

## Official Supabase CLI adapter

The `supabase` command group is a thin, allowlisted adapter around the official
open-source Supabase CLI. It is not a fork. Local authoring commands work without
SupaCloud credentials:

```bash
supacloud-cli supabase version
supacloud-cli supabase migration_new --name add_accounts
supacloud-cli supabase db_diff --schema public --name add_accounts
supacloud-cli supabase db_reset --no_seed
```

Remote inspection and backup commands require an explicit, percent-encoded
Postgres DSN:

```bash
supacloud-cli supabase db_pull --db_url "$SUPACLOUD_DB_URL" --declarative
supacloud-cli supabase migration_list --db_url "$SUPACLOUD_DB_URL"
supacloud-cli supabase db_dump --db_url "$SUPACLOUD_DB_URL" --file backups/schema.sql
supacloud-cli supabase gen_types --db_url "$SUPACLOUD_DB_URL" --schema public --file src/database.types.ts
```

Remote migration application intentionally stays on SupaCloud's existing
project-authenticated API:

```bash
supacloud-cli supabase push --ref abc123 --dir supabase/migrations --dry_run
supacloud-cli supabase push --ref abc123 --dir supabase/migrations
```

`push` uses `SUPABASE_SERVICE_ROLE_KEY` or `SUPACLOUD_API_TOKEN` only for the
SupaCloud Management API. Those credentials, upstream access tokens, database
passwords, and secret/key environment variables are removed from the official
CLI child process, and command output is redacted.

`push` requires a resolved project ref; pass `--ref` explicitly or set
`SUPACLOUD_PROJECT_REF`. Relative migration directories are resolved against
`--workdir` (or the current directory).

Executable resolution order:

1. `SUPACLOUD_SUPABASE_CLI_BIN`
2. exact `SUPABASE_CLI_VERSION` through an explicit Bun/npm package runner
3. `<workdir>/node_modules/supabase`
4. `supabase` on `PATH`

Windows under Node.js requires an installed official CLI or
`SUPACLOUD_SUPABASE_CLI_BIN`; the adapter does not execute `.cmd` through a shell.

Direct SQL/console changes do not automatically create migrations or migration
history. Keep migration files in version control and run `supabase push --dry_run`
before applying them.

If the live database already contains reviewed historical changes, first pull,
back up, and prove schema equivalence. Then preview the controlled tracking sync:

```bash
supacloud-cli database baseline_migrations --ref abc123 --dir supabase/migrations --dry_run
```

Only after explicit approval, rerun without `--dry_run`. This records migration
files as applied without executing their DDL; never edit migration-history tables
through `database query`.

Use `database query --file` for complex SQL, pgvector queries, and single-request transaction blocks.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content text NOT NULL,
  embedding vector(1536)
);

CREATE INDEX documents_embedding_hnsw_idx
ON documents
USING hnsw (embedding vector_cosine_ops);
```

Transaction boundary: SupaCloud supports transaction blocks inside one SQL request and transactional migrations. It does not expose long-lived HTTP transaction sessions; use a direct Postgres DSN for application-side long transactions.

Project commands owned by this CLI:

- `project get`
- `project health`
- `project logs`
- `project api_keys`
- `project settings`
- `project tasks`
- `project task_detail`
- `project task_stats`
- `project task_cancel`
- `project task_retry`
- `project dlq`
- `project background_settings`
- `project update_background_settings`

Queue commands:

- `queue list`
- `queue send`
- `queue receive`
- `queue ack`
- `queue release`
- `queue fail`
- `queue retry`
- `queue delete_message`
- `queue list_messages`
- `queue get_message`
- `queue stats`
- `queue dlq`
- `queue get_settings`
- `queue update_settings`

Task event commands:

- `task_events register_webhook`
- `task_events unregister_webhook`
- `task_events inspect_webhook`

Diagnostic commands:

- `diagnostics list_checks`
- `diagnostics run_checks`
- `diagnostics get_run`
- `diagnostics repair`

Gateway / Caddy commands (require admin privileges; config is injected via the Caddy JSON Admin API):

- `gateway routes` — list custom gateway routes (reverse_proxy / static sites / redirects)
- `gateway upsert_route` — create or replace a route
- `gateway update_route` — replace a route by id
- `gateway delete_route` — remove a route by id
- `gateway config` — update rate-limit tier, CORS origins, or JWT settings
- `gateway get_certificate` — read certificate automation settings
- `gateway update_certificate` — save certificate automation settings
- `gateway issue_certificate` — issue or renew a certificate with lego
- `gateway deploy_certificate` — deploy an existing PEM cert/key pair
- `gateway rebuild` — rebuild all tenant gateway configs (`--clean` for a full rebuild)
- `gateway custom_hostname` — read the bound custom hostname
- `gateway set_custom_hostname` — bind a custom hostname
- `gateway delete_custom_hostname` — remove the custom hostname
- `gateway verify_custom_hostname` — verify a custom hostname

```bash
supacloud-cli gateway routes --ref abc123
supacloud-cli gateway upsert_route --ref abc123 --route_id webhook \
  --hosts "api.example.com" --paths "/webhook/*" --upstream 10.0.0.5:8080
supacloud-cli gateway upsert_route --ref abc123 --route_id canonical-https \
  --hosts "www.example.com" --paths "/*" --protocol http \
  --redirect_to 'https://www.example.com{http.request.uri}' --redirect_status 308
supacloud-cli gateway config --ref abc123 --rate_limit_tier pro
supacloud-cli gateway rebuild --ref abc123 --clean
```

For server installation, SSH diagnostics, and tenant administration, use `@supacloud/admin`.
