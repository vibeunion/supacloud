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
legacy `.env` fallback. Core URL, credential, and project-ref values are not
filled by mixing sources. If `SUPACLOUD_ENV` is set without a complete process
context, it strictly selects `.env.supacloud.<value>`.

The two credential scopes are separate. Management-backed remote commands use
only `SUPACLOUD_API_URL` + `SUPACLOUD_API_TOKEN`. An application profile using
`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` can be auto-linked for `status`,
but its service-role key is never substituted for a Management token and cannot
enable Management-backed tools. Both URL types must be canonical HTTPS origins;
omit explicit default ports such as `:443`. HTTP is accepted only for literal
loopback development origins, with the default `:80` likewise omitted. Use
`SUPACLOUD_PROJECT_REF` when it cannot be inferred from a managed
`<ref>.api.*` application hostname.

### Verified release controls

`release` is an official CLI entry point for verified Management API controls
and the release-canary fixture receipt replay. Management actions require the
Management API context above. `release_canary_fixture_stage_replay` additionally
requires the same project's `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; the
key is sent only to that application origin and is never promoted to Management
authority.

Project pause and restore are explicit lifecycle commands. A logical backup
restore requires an operator to pause the selected project first and then use
`project get` to confirm that its status is `paused`. `project restore` resumes
the paused project lifecycle when its database exists; if the database is
missing, the platform begins project re-provisioning instead. It does not
restore a database backup and is never invoked automatically by the CLI.

```bash
supacloud-cli project pause --ref abc123
supacloud-cli release logical_backup_restore --ref abc123 \
  --backup_id logical-full_abc123_<backup-id-suffix> \
  --expected_sha256 <64-lowercase-hex> \
  --restore_confirmation RESTORE_PROJECT:abc123:logical-full_abc123_<backup-id-suffix>:<64-lowercase-hex>
supacloud-cli project restore --ref abc123
```

```bash
supacloud-cli release logical_backup_list --ref abc123
supacloud-cli release logical_backup_create --ref abc123
supacloud-cli release logical_backup_restore --ref abc123 \
  --backup_id logical-full_abc123_<backup-id-suffix> \
  --expected_sha256 <64-lowercase-hex> \
  --restore_confirmation RESTORE_PROJECT:abc123:logical-full_abc123_<backup-id-suffix>:<64-lowercase-hex>
supacloud-cli release postgrest_status --ref abc123
supacloud-cli release postgrest_restart --ref abc123
supacloud-cli release release_canary_fixture_stage_replay --ref abc123 \
  --subject <central-subject-uuid> --request_id <stage-request-uuid>
supacloud-cli release release_canary_fixture_disable_replay --ref abc123 \
  --fixture_id <fixture-uuid> --disable_request_id <disable-request-uuid> \
  --issuer <issuer-url> --subject <central-subject-uuid>
```

Backup creation reports success only after the CLI verifies exactly one new
logical-backup receipt against the inventory before and after the mutation.
Logical restore is project-scoped: pause the selected project first, obtain the
backup ID and SHA-256 from `logical_backup_list`, and supply both the normal
production `--confirm-production <ref>` value (for production profiles) and
the exact `--restore_confirmation
RESTORE_PROJECT:<ref>:<backup_id>:<sha256>`. Before POST, the CLI re-reads
that same project's inventory and binds the request to the complete verified
backup identity; it then verifies both the server receipt and a fresh inventory
read. It never retries a restore. A transport, server, or unreadable-response
failure is reported as `OUTCOME_UNKNOWN`; read the inventory and investigate
before any new restore decision.

PostgREST restart reports success only after it receives a matching restart
receipt and reads back `desired=running`, `actual=running`, and
`health=healthy`. Both mutating controls follow the normal production
confirmation and read-only protections.

`release_canary_fixture_stage_replay` performs one non-retried, response-bounded
call to the fixed `fa_release_canary_fixture_stage` PostgREST RPC with both
bearer and `apikey` service-role headers. It accepts only canonical subject and
request UUIDs, requires a strict `staged` and `idempotent=true` four-field
receipt, and emits only that safe projection. Before and after the call, the CLI
reads the selected project's authoritative endpoint projection and requires the
configured application origin to match its API origin or alias. Production
confirmation is mandatory.

`release_canary_fixture_disable_replay` performs one non-retried call to the
fixed `fa_release_canary_fixture_disable` PostgREST RPC using the selected
project's application service-role origin. Its receipt must contain exactly
`fixtureId`, `state="disabled"`, and a boolean `idempotent`; both the first
disable (`idempotent=false`) and same-request replay (`idempotent=true`) are
valid. The CLI then calls the existing fixed
`fa_release_canary_fixture_pending` RPC with the exact fixture, issuer, and
subject and requires an identity-matching `pending=false` read-back before
reporting success. Management endpoint projection is checked before and after.

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

`status` checks configuration, connectivity, and authentication against the
selected credential scope. Application profiles probe the project data API at
the exact configured origin; credential-bearing probes refuse redirects. The
command exits non-zero when any required check fails. Its output includes
`credentialScope`, `environment`, `source` (`kind` and `path`), `apiUrl`,
`projectRef`, `readOnly`, `production`, and `hasApiToken`. It never prints the
API token or service-role key.

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
supacloud-cli database migration_inventory --ref abc123
supacloud-cli database push_migrations --ref abc123 --dir supabase/migrations --dry_run
supacloud-cli supabase migration_new --name add_accounts
supacloud-cli supabase db_diff --schema public --name add_accounts
supacloud-cli supabase push --ref abc123 --dir supabase/migrations --dry_run
supacloud-cli frontend list --ref abc123
supacloud-cli branch create --name feature-orders --data_mode schema_only
supacloud-cli branch promotion_plan --branch_ref preview123
supacloud-cli branch promote --branch_ref preview123 --plan_checksum <sha256>
supacloud-cli edge_functions get_config --ref abc123 --slug hello
supacloud-cli edge_functions deploy --ref abc123 --slug hello --path ./supabase/functions/hello --expected-active-version absent --expected-activation-id legacy
supacloud-cli edge_functions deploy --ref abc123 --slug hello --prebundled-path ./dist/hello.js --expected-sha256 <sha256> --expected-active-version 4 --expected-activation-id <uuid>
supacloud-cli edge_functions deploy_bundle --ref abc123 --slug hello --files '{"index.ts":"export default { fetch: () => new Response(\"ok\") }"}' --expected-active-version 7 --expected-activation-id <uuid>
supacloud-cli edge_functions source --ref abc123 --slug hello --version 7 --output ./hello-v7.ts
supacloud-cli edge_functions activate --ref abc123 --slug hello --version 3 --expected-active-version 8 --expected-activation-id <uuid>
supacloud-cli edge_functions delete --ref abc123 --slug hello --expected-activation-id <uuid>
supacloud-cli scheduled_functions list --ref abc123
supacloud-cli secrets upsert --ref abc123 --from-env API_KEY,WEBHOOK_SECRET
supacloud-cli storage list_buckets --ref abc123
supacloud-cli storage get_bucket --ref abc123 --bucket reports
supacloud-cli storage create_bucket --ref abc123 --bucket reports --public false \
  --file_size_limit 10485760 --allowed_mime_types "application/pdf,image/png"
supacloud-cli storage update_bucket --ref abc123 --bucket reports \
  --expected_revision <revision-from-get_bucket> \
  --allowed_mime_types '["application/pdf"]'
supacloud-cli storage delete_bucket --ref abc123 --bucket reports \
  --expected_revision <revision-from-get_bucket> --require_empty true
```

`database migration_inventory` reads the canonical migration ledger through the
project-scoped Management API and prints only a validated JSON array. It rejects
non-2xx responses, malformed entries, unsafe project refs, duplicate canonical
migration versions, checksum
drift, and statement-count mismatches instead of treating them as an empty
ledger. `database list_migrations` remains available with its legacy SQL-backed,
human-readable behavior.

Bucket list/get output includes the metadata `revision`. Update and delete reject
stale revisions with HTTP 409. Delete additionally requires `require_empty=true`;
it never empties a bucket. Mutation receipts bind `project_ref`, `bucket_id`,
`previous_revision`, and `new_revision` (`null` after delete).

`database push_migrations` rejects a remote row that reuses a local migration
name with another version, or a local version with another name, before either
dry-run reporting or apply can continue. This keeps the preview consistent with
the server conflict that would otherwise occur after deployment starts.
Mutation failures use the release-control receipt schema and never include the
server response body. `OUTCOME_UNKNOWN` requires a fresh migration inventory
read before deciding whether a retry is safe. A migration push failure also
reports the local files applied or skipped before the failed file, so operators
can reconcile a partially completed sequence without exposing SQL. Baseline
success requires a bounded migration-inventory readback that confirms every
requested version, name, baseline marker, and checksum.

`edge_functions deploy --path` bundles local TypeScript and dependencies with
Bun and runs a local syntax check before upload. The Management API validates and
normalizes the final server-side artifact against the multi-tenant Edge Runtime
module policy consistently for CLI, Web Console, and direct API deployments.
For an artifact already built and validated by release automation, use
`deploy --prebundled-path <file> --expected-sha256 <64-lowercase-hex>`. The CLI
holds the opened regular file while reading it, rejects metadata drift, invalid
UTF-8, or a caller-hash mismatch before HTTP, and never passes the artifact in
the process argument list. The Management API validates the hash and runtime
policy again, rejects any normalization that would change the code, and stores
the submitted bytes unchanged as both immutable source and runtime artifact.
`--prebundled-path` is mutually exclusive with `--path`, `--code`, and
`--minify`.
`deploy_bundle --files` accepts a JSON object in shell usage.
Use `source --output <file>` for large Functions so terminal or automation output
limits cannot truncate the original TS/JS source code. The destination must not
already exist. Add the positive version observed from `list` as
`source --version <N>` to read the immutable release instead of the moving active
pointer; this remains correct across an active-version A→B→A transition.

`deploy`, `deploy_bundle`, and `activate` require
`--expected-active-version <N|absent>`. Read the current non-negative integer
version from `edge_functions list`; use `0` for a listed legacy Function and
`absent` only when creating a slug that does not yet exist. A stale value returns
HTTP 409 without building, preheating, or activating another version. Every
Function mutation also requires `--expected-activation-id <uuid|legacy>` from
the same `list` or `get_config` snapshot. Use `get_config` for a single atomic
read of `active_version`, `activation_id`, and policy, including an `absent`
tombstone after deletion. Use `legacy` only for a never-created slug or a listed
legacy Function; recreating a deleted slug must use the tombstone UUID returned
by `delete` or `get_config`. This second token prevents an A→B→A version cycle
from satisfying a stale mutation. List output remains a JSON array with string
`slug`, numeric `version`, and canonical `activation_id` fields, while source
output is exactly `{ "code": "..." }`. Release automation must use
`source --version <N>` for a version-bound backup.

`edge_functions activate` restores an existing immutable Function version and
returns a machine-readable receipt containing the activated version and JWT
policy. HTTP and malformed-response failures exit non-zero without echoing the
server response body.

Mutation receipts use schema `supacloud.cli.release-control.v1`. An
`OUTCOME_UNKNOWN` error means the server may have committed the mutation before
the response was lost or failed validation; read back current state before any
retry. For Function deploy, bundle deploy, activation, config, and delete, the
CLI applies a separate 5-second, 64 KiB response-body boundary after receiving
HTTP headers. A stalled, oversized, truncated, unreadable, or malformed body is
always `OUTCOME_UNKNOWN` and its content is never included in CLI output.
Version `0` is reserved as the active-version CAS token for legacy Functions. It
can be passed only as `--expected-active-version`; immutable source reads and
activation targets still require a positive version.

```json
{
  "schema": "supacloud.cli.release-control.v1",
  "ok": true,
  "operation": "edge_functions.deploy_bundle",
  "project_ref": "abc123",
  "slug": "hello",
  "previous_active_version": "7",
  "expected_activation_id": "9dc0e8da-207f-4f25-ae74-b1de4e66784d",
  "activation_id": "6417591d-c038-46e8-91ca-4c8080514144",
  "active_version": "8",
  "version": "8",
  "verify_jwt": true
}
```

Scheduled Function lifecycle operations are also project-scoped:

```bash
supacloud-cli scheduled_functions create --ref abc123 --name nightly \
  --slug cleanup --cron "0 2 * * *" --method POST
supacloud-cli scheduled_functions get --ref abc123 --schedule_id <id>
supacloud-cli scheduled_functions update --ref abc123 --schedule_id <id> \
  --expected_updated_at <updated_at-from-list> --cron "0 3 * * *"
supacloud-cli scheduled_functions delete --ref abc123 --schedule_id <id> \
  --expected_updated_at <updated_at-from-list>
```

Schedule IDs are canonical UUIDv4 values returned by create/list. Cron values
use bounded numeric five-field syntax with wildcards, lists, ranges, and steps;
out-of-range endpoints and steps are rejected before HTTP dispatch.
Update and delete require the exact canonical UTC `updated_at` returned by list.
A stale revision fails with HTTP 409 and performs no mutation; read the list
again before deciding whether to issue a new write.

Use `--body_file ./payload.json` for a JSON-object request body. Header values
must come from environment variables: pass a JSON name mapping such as
`--header_env '{"x-schedule-token":"SCHEDULE_TOKEN"}'`. Platform-owned
`authorization`, `apikey`, and `x-project-ref` headers cannot be overridden. Receipts never
include header values or body content; list and mutation receipts report only
whether the body is empty and the configured header names. Update receipts bind
`previous_updated_at` to the requested revision and return a newer `updated_at`;
delete receipts return the matched revision as `deleted_updated_at`.

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

`push` uses only `SUPACLOUD_API_TOKEN` for the SupaCloud Management API. That
token, upstream access tokens, database passwords, and secret/key environment
variables are removed from the official CLI child process, and command output
is redacted.

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
