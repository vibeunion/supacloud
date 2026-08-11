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

## Environment profiles and production safety

Use named environment files to keep test and production configuration separate.
`--env test` reads `.env.supacloud.test` from the current working directory;
`--env prod` reads `.env.supacloud.prod` and treats the profile as production.
For example:

```dotenv
# .env.supacloud.test
SUPACLOUD_ENV=test
SUPACLOUD_API_URL=https://management.test.example.com
SUPACLOUD_API_TOKEN=<test-management-api-token>
SUPACLOUD_PROJECT_REF=test-ref
```

```dotenv
# .env.supacloud.prod
SUPACLOUD_ENV=production
SUPACLOUD_API_URL=https://management.example.com
SUPACLOUD_API_TOKEN=<production-management-api-token>
SUPACLOUD_PROJECT_REF=production-ref
```

Run commands with the selected profile:

```bash
supacloud-cli --env test status
supacloud-cli project get --env test
supacloud-cli status --env-file ./config/supacloud.staging.env
```

Global flags may appear before or after the command. Both `--key value` and
`--key=value` syntax are accepted. `--env` and `--env-file` are mutually
exclusive. An explicit `--env-file` must declare `SUPACLOUD_ENV`.

Environment files contain credentials. The repository root `.gitignore`
already ignores `.env` and `.env.*`; do not force-add or commit these files.
Restrict locally created files to the current user:

```bash
chmod 600 .env.supacloud.test .env.supacloud.prod
```

CI can provide one complete context through process environment variables
instead of writing a file:

```bash
SUPACLOUD_ENV=test \
SUPACLOUD_API_URL=https://management.test.example.com \
SUPACLOUD_API_TOKEN="$CI_SUPACLOUD_API_TOKEN" \
SUPACLOUD_PROJECT_REF=test-ref \
supacloud-cli status
```

Project context is resolved from one atomic source: a named profile selected by
`--env`, an explicit `--env-file`, a complete process environment, or the
legacy `.env` fallback. Core URL, token, and project-ref values are not filled
by mixing sources. If `SUPACLOUD_ENV` is set without a complete process context,
it strictly selects `.env.supacloud.<value>`. For backward compatibility, when
no selector and no core process variables are present, `supacloud-cli` still
tries to auto-link from `.env` using:

- `SUPABASE_URL` or `SUPACLOUD_API_URL`
- `SUPABASE_SERVICE_ROLE_KEY` or `SUPACLOUD_API_TOKEN`
- `SUPACLOUD_PROJECT_REF` when the project ref cannot be inferred from a managed `<ref>.api.*` hostname

The legacy `.env` fallback is unclassified and therefore does not enable the
production confirmation gate. Production automation must select a `prod` or
`production` profile, or set `SUPACLOUD_ENV=production` together with a complete
process context. Use `SUPACLOUD_READ_ONLY=true` when legacy workflows must be
restricted to inspection only.

`SUPACLOUD_READ_ONLY=true` is a safety override that blocks remote writes.
Production writes require an explicit confirmation equal to the selected
profile's project ref:

```bash
supacloud-cli database push_migrations --env prod \
  --ref production-ref --dir supabase/migrations \
  --confirm-production production-ref
```

Dry runs remain read operations. Production `diagnostics repair` is always
forbidden, and unclassified actions fail closed in production or read-only
contexts.

For supported command groups, `--ref` overrides the profile's default project
for one command. A production profile cannot target a different project with
`--ref`; the requested ref and `--confirm-production` must both exactly match
the profile's project ref.

`status` checks configuration, Management API connectivity, and authentication;
it exits non-zero when any required check fails. Its output includes
`environment`, `source` (`kind` and `path`), `apiUrl`, `projectRef`, `readOnly`,
`production`, and `hasApiToken`. It never prints the API token or service-role
key.

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
supacloud-cli edge_functions activate --ref abc123 --slug hello --version 3
supacloud-cli scheduled_functions list --ref abc123
supacloud-cli secrets upsert --ref abc123 --from-env API_KEY,WEBHOOK_SECRET
supacloud-cli storage list_buckets --ref abc123
supacloud-cli storage get_bucket --ref abc123 --bucket reports
supacloud-cli storage create_bucket --ref abc123 --bucket reports --public false \
  --file_size_limit 10485760 --allowed_mime_types "application/pdf,image/png"
supacloud-cli storage update_bucket --ref abc123 --bucket reports \
  --allowed_mime_types '["application/pdf"]'
supacloud-cli storage delete_bucket --ref abc123 --bucket reports
```

`edge_functions deploy --path` bundles local TypeScript and dependencies with
Bun and runs a local syntax check before upload. The Management API validates and
normalizes the final server-side artifact against the multi-tenant Edge Runtime
module policy consistently for CLI, Web Console, and direct API deployments.
`deploy_bundle --files` accepts a JSON object in shell usage.
Use `source --output <file>` for large Functions so terminal or automation output
limits cannot truncate the original TS/JS source code. The destination must not
already exist.

`edge_functions activate` restores an existing immutable Function version and
returns a machine-readable receipt containing the activated version and JWT
policy. HTTP and malformed-response failures exit non-zero without echoing the
server response body.

Mutation receipts use schema `supacloud.cli.release-control.v1`. An
`OUTCOME_UNKNOWN` error means the server may have committed the mutation before
the response was lost or failed validation; read back current state before any
retry.

Scheduled Function lifecycle operations are also project-scoped:

```bash
supacloud-cli scheduled_functions create --ref abc123 --name nightly \
  --slug cleanup --cron "0 2 * * *" --method POST
supacloud-cli scheduled_functions update --ref abc123 --schedule_id <id> \
  --cron "0 3 * * *"
supacloud-cli scheduled_functions delete --ref abc123 --schedule_id <id>
```

Schedule IDs are canonical UUIDv4 values returned by create/list. Cron values
use bounded numeric five-field syntax with wildcards, lists, ranges, and steps;
out-of-range endpoints and steps are rejected before HTTP dispatch.

Use `--body_file ./payload.json` for a JSON-object request body. Header values
must come from environment variables: pass a JSON name mapping such as
`--header_env '{"x-schedule-token":"SCHEDULE_TOKEN"}'`. Platform-owned
`authorization`, `apikey`, and `x-project-ref` headers cannot be overridden. Receipts never
include header values or body content; list and mutation receipts report only
whether the body is empty and the configured header names.

For secret writes, `--from-env` accepts a comma-separated list of environment
variable names. The CLI reads each non-empty value from its own process
environment, so command arguments contain names only and values are never
printed. Names must be unique shell-style identifiers (`[A-Za-z_][A-Za-z0-9_]*`,
up to 256 characters). Missing or empty values fail before any HTTP request.
Do not combine `--from-env` with the compatibility `--secrets` input.

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

Auth configuration commands accept a JSON object from the CLI:

```bash
supacloud-cli auth update_settings --ref abc123 \
  --config '{"disable_signup":true,"enable_signup":false}'
supacloud-cli auth update_config --ref abc123 \
  --config '{"third_party_auth":{"enabled":true}}'
```

Failed Auth mutations exit non-zero and print a JSON object containing the HTTP
status plus an allowlisted subset of runtime-apply state. If Management API
returns `503` with `persisted: true`, the desired configuration was saved but
runtime propagation was incomplete; automation must read the affected settings
back exactly before deciding whether it is safe to continue. Free-form server
messages and request configuration are not echoed.

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
