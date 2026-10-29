# SupaCloud CLI Guide

SupaCloud exposes three explicit local command surfaces with strict ownership boundaries:

- `@supacloud/cli` / `supacloud`
- `@supacloud/admin` / `supacloud-admin`
- the optional `supacloud` npm package / `supacloudctl`, whose normal dispatch is local-only; `supacloudctl check-update [cli|admin]` explicitly queries npm without downloading or executing `latest`

Project work uses `supacloud`, platform upgrades use `supacloud-admin`, and
the optional local umbrella command is `supacloudctl`. The server's native
`/usr/local/bin/supacloud` is a separate managed-host installation.

```text
supacloud            project-scoped user/developer CLI
supacloud-admin      server and platform administration CLI
supacloudctl         local dispatcher for the two installed CLIs
/usr/local/bin/supacloud  compiled server binary on managed hosts
```

## `supacloud`

Project-scoped by default. Intended for project users and developers.

### Context model

- Prefers the current workspace `.env`
- Reads `SUPABASE_URL` or `SUPACLOUD_API_URL`
- Reads `SUPABASE_SERVICE_ROLE_KEY` or `SUPACLOUD_API_TOKEN`
- Reads `SUPACLOUD_PROJECT_REF` when the ref cannot be inferred
- Can still accept explicit `--ref` when needed

### First-run project setup

For an existing SupaCloud application with a Vue/Vite, Svelte or static frontend,
initialize the project profiles once:

```bash
supacloud init
supacloud env list
supacloud env check
supacloud --env test deploy
```

`init` creates `supacloud.json`, non-secret
`.env.supacloud.test.example` and `.env.supacloud.production.example` files,
and adds ignore rules for real profile files. It never overwrites an existing
`supacloud.json`. The output directory is inferred from the detected framework
(`dist` for Vite/Vue, `out` for Next.js and `build` for Svelte).
Set `SUPACLOUD_APPLICATION_ID` in the selected profile to the application's ID,
and configure its current SupaCloud delivery build. A standalone frontend profile
without an application binding no longer enables deployment.

Copy an example to a real profile and fill in credentials locally:

```bash
cp .env.supacloud.test.example .env.supacloud.test
supacloud env check --json
```

`env list` and `env check` are local-only. They never contact the Management API
and never print token or service-role values. `env check` distinguishes a profile
that is valid for `status` from one that is ready for `deploy`; incomplete
production profiles fail before any remote command is attempted.

When auto-linking from `SUPABASE_URL`, the CLI accepts tenant API domains and
derives the matching Management API host. For example,
`https://api.example.com` maps to `https://studio.example.com`, and
`https://abc123.api.example.com` maps to `https://studio-abc123.example.com`.
The managed hostname also supplies project ref `abc123`. A custom domain such
as `https://api.example.com` can derive the Management API host but not a project
ref; set `SUPACLOUD_PROJECT_REF` or pass `--ref`. Set `SUPACLOUD_API_URL`
explicitly to override host inference.

### Typical commands

```bash
npm install -g @supacloud/cli

supacloud status
supacloud deploy
supacloud project get
supacloud project logs --log_type database
supacloud database query --sql "select now()"
supacloud database query --ref abc123 --file ./queries/vector-search.sql
supacloud database push_migrations --ref abc123 --dir supabase/migrations --dry_run
supacloud supabase migration_new --name add_accounts
supacloud supabase db_diff --schema public --name add_accounts
supacloud supabase push --ref abc123 --dir supabase/migrations --dry_run
supacloud frontend list --ref abc123
supacloud frontend list_releases --ref abc123 --id web
```

### One-command deploy

`supacloud deploy` publishes the configured static frontend through its direct
release path. It does not wait for the Application backend, migrations, Edge
Functions or Storage. Use `supacloud deploy --backend` for an Application
backend release; it builds and uploads the immutable artifact, inserts a durable
job, and returns `accepted` before background migration/runtime activation.
Use `supacloud deploy --status <deployment-id>` to read its verified state.
Only a later `succeeded` receipt means the backend is complete. The CLI builds
and uploads artifacts; SupaCloud plans the release, reads CAS and verifies the
result.
The CLI first performs a bounded read-only protocol check. A missing, mismatched
or cross-environment response stops the command before building or uploading.
Upgrade the CLI and server together; there is no legacy deployment fallback.

### Application rollback

Application releases can be inspected and rolled back without guessing from the
release list:

```bash
supacloud app rollback-plan --id reviews --environment_id test
supacloud app rollback --id reviews --environment_id test
```

The plan is read-only. For a default rollback, SupaCloud selects the previous
activation from the successful journal, verifies its retained release and
configuration evidence, and uses the current activation as the CAS value. The
CLI creates a new activation ID and does not replay an uncertain request.
Rollback re-runs compatibility, readiness and route checks; it does not reverse
database migrations, restore business data, or undo external side effects.
Explicit `--release_id`, `--configuration_id` and
`--expected_activation_id` values remain available when an operator has a
separately verified target.

### Remote test development sync

For a dedicated test server, use `dev` to synchronize source files over SSH and
reload only the affected development target. This path is separate from
immutable Function releases and is rejected for production environments.

```bash
supacloud --env test dev sync --target functions --function api
supacloud --env test dev sync --target db
supacloud --env test dev watch --target project
supacloud --env test dev status
```

The selected environment supplies `SUPACLOUD_DEV_HOST` (or `SUPACLOUD_HOST`)
and the existing `SUPACLOUD_SSH_*` settings. A repository may add a `dev` section to
`supacloud.json`:

```json
{
  "dev": {
    "remoteRoot": "/var/lib/supacloud/dev/test-project",
    "reloadCommand": "supacloud-dev-agent reload",
    "compile": true,
    "compileRoot": ".",
    "compileOutDir": "generated",
    "compileStrict": true,
    "database": {
      "drizzleConfig": "drizzle.config.ts",
      "migrationsDir": "supabase/migrations",
      "strict": true
    },
    "excludes": ["node_modules", ".git", ".env*", "dist"]
  }
}
```

The syncer creates the target directory remotely, transfers the selected source
tree with checksum-aware `rsync`, and invokes the configured reload agent over
SSH. Secrets and environment files are excluded by default. Database syncing is
explicit (`dev sync --target db`); file watching does not execute migrations
automatically. When `dev.compile` is enabled, `@supacloud/compiler` runs before
sync; generated factories and `app.manifest.json` must be written inside the
selected sync tree or be included by the project target. Compilation errors stop
the sync and reload. `dev migrate` runs `drizzle-kit generate`, performs a
SupaCloud migration dry-run, and only applies when `--apply` is explicitly set:

```bash
supacloud --env test dev migrate
supacloud --env test dev migrate --apply
```

For executable application delivery, bind the application in the selected profile
or repository-root `supacloud.json`. Static-only sites omit `application` entirely.
For a frontend in a separate directory:

```json
{
  "application": { "id": "orders", "environmentId": "test" },
  "frontend": {
    "root": "apps/web",
    "id": "web",
    "buildCommand": "bun run build",
    "outputDirectory": "dist",
    "buildEnv": ["VITE_API_URL", "VITE_SUPABASE_ANON_KEY"]
  }
}
```

`buildEnv` is for public build-time variables. The CLI rejects platform
credentials and sensitive names such as tokens, passwords, database URLs, and
private keys. Runtime secrets use the separate Secrets API and are never copied
into a static frontend build.

```bash
# Upgrade before migrating an old deployment script.
npm install -g @supacloud/cli@latest
supacloud --env test deploy
# Existing Web output and an application manifest configured in the profile:
supacloud --env test deploy --skip_build
# Publish only static assets while preserving a mixed repository's backend:
supacloud --env test deploy --assets_only
```

`--target`, `--id`, `--build_command`, `--output_dir`, `--plan`, `--diff` and
`--dry_run` were removed from `deploy`. Build settings belong in configuration.
Use `app deploy-plan` for an explicit read-only review of an uploaded application
release. Standalone `edge_function` target declarations must be migrated to the
application delivery configuration; the CLI will not silently omit them.
Historical `deploy-manifest.json` files are not reused as deployment scopes.
Explicit `--assets_only` leaves them and all Functions/schedules untouched.

Production profiles retain the standard explicit confirmation gate:

```bash
supacloud --env production --confirm-production abc123 deploy
```

Both `--key value` and `--key=value` syntax are supported. `supacloud status`
reports configuration, Management API connectivity, and authentication as
separate checks, and returns a non-zero exit code when a required check fails.

One-off execution without global install:

```bash
npm exec --package @supacloud/cli -- supacloud status
```

Bun users can force the same package to run with Bun, including on Windows:

```bash
bunx --bun --package @supacloud/cli supacloud status
```

### Application framework commands

Local commands for the application framework (`@supacloud/app` +
`@supacloud/compiler`) and database governance (`@supacloud/db`). They run
without a Management API context and never mutate the database.

```bash
# scaffold modules, commands, queries and controllers
supacloud app generate --kind module --name case
supacloud app generate --kind command --name accept --module case

# compile decorator metadata into static factories + app.manifest.json
supacloud app compile --root . --out_dir generated --strict

# validate only (no files written), print the module dependency tree,
# or explain a single provider/command/controller
supacloud app check
supacloud app graph --format json
supacloud app explain --target CaseService
supacloud app export-tools
supacloud app export-tools --format json

# SQL governance over defineDatabaseModule sources
supacloud db context --root . --module_file db/modules.ts --module cases
supacloud db context --root . --module_file db/modules.ts --target public.case_create
supacloud db lint --module_file db/modules.ts
supacloud db explain --target public.case_create

# read-only catalog reconcile against a live database
supacloud db module_check --module_file db/modules.ts --database_url "$DATABASE_URL"

# or reconcile against a local SupaCloud Lite project (delegates to supacloud-lite db check)
supacloud db module_check --lite --project_dir .
```

`app export-tools` reads `generated/app.manifest.json` and exports commands with
declared permissions as OpenAI Function Calling and MCP tool contracts. The
default mode writes `generated/tool-definitions.openai.json` and
`generated/tool-definitions.mcp.json`; `--format json` prints both contracts
without writing files. Input schemas retain their source TypeBox symbol names
as references until a schema exporter is added to the compiler.

`db module_check` is classified read-only: it introspects `pg_policy`,
`pg_proc`, `pg_class` and grants, and reports drift between the declared
manifest and the live catalog (missing policies, RLS disabled, security
definer without a pinned `search_path`, PUBLIC grants). With `--lite` the
check runs against a local SupaCloud Lite project instead of a connection
URL (requires `supacloud-lite` on PATH). See
[Database Governance](./database-governance.md) and
[Application Framework](./application-framework.md).

`db context` is a read-only, structured context projection for AI agents. It
returns only the selected database modules or object and includes each
maintained source/test path, the Drizzle-versus-SQL ownership boundary,
protected/generated paths, and focused verification commands. It does not
read or rewrite the historical migration directory.

### AI/Agent Skill

`@supacloud/cli` ships a `supacloud` Skill for Codex and other Skill-compatible
agents. The human guide remains this document; the Skill converts the same
rules into runtime instructions so an agent does not default to direct remote
SQL or Management API writes.

```bash
# Inspect the packaged source and default Codex destination.
supacloud ai show_skill

# Preview installation; no project credentials are needed.
supacloud ai install_skill --dry_run

# Install into $CODEX_HOME/skills or ~/.codex/skills.
supacloud ai install_skill

# Install into another agent's explicit Skill root.
supacloud ai install_skill --target /path/to/skills
```

Installation is idempotent. If an existing `supacloud` Skill differs, the
CLI refuses to overwrite it. `--force` creates a timestamped adjacent backup
before replacement; combine it with `--dry_run` to preview the backup path.

The packaged Skill enforces these defaults for agents:

- database schema, functions/RPC, triggers, RLS, indexes, grants, extensions,
  and reference-data changes are migration-first;
- `database query` is read-only by default;
- remote migration apply must follow local verification and `--dry_run`;
- production apply needs explicit approval in the current task;
- direct historical edits must be pulled, backed up, compared, and reconciled;
- migration-history rows must never be edited through ordinary SQL commands.

Restart or reload the agent after installing/updating a Skill so its discovery
catalog is refreshed.

### SupaCloud Lite CLI adapter

Lite supports CLI workflows through its standalone `supacloud-lite` binary and
through `supacloud lite`. The main CLI adapter is local-only: it does not
use Management API credentials, the official Supabase CLI, or a Postgres DSN
for the PGlite state directory.

```bash
supacloud lite migrate --project_dir .
supacloud lite status --project_dir .
supacloud lite db_diff --project_dir . --file add_accounts
supacloud lite db_pull --project_dir . --file remote_schema
supacloud lite gen_types --project_dir . --output src/database.types.ts
supacloud lite snapshot_create --project_dir . --output backups/lite.tar.gz
supacloud lite doctor --project_dir . --json
supacloud lite start --project_dir . --port 54321
```

Executable resolution is `SUPACLOUD_LITE_CLI_BIN`, then the project-local
`@supacloud/lite` launcher, then `supacloud-lite` on `PATH`. The `supabase`
module remains reserved for the official Supabase CLI and Management-backed
remote project operations.

### Official Supabase CLI adapter

`supacloud supabase` is a thin, allowlisted adapter around the official
open-source Supabase CLI. SupaCloud does not fork or vendor the upstream CLI.
The adapter resolves the executable in this order:

1. `SUPACLOUD_SUPABASE_CLI_BIN` (an explicit executable path)
2. `SUPABASE_CLI_VERSION=2.120.0` as the recommended pinned Bun/npm package runner version
3. `<workdir>/node_modules/supabase`
4. `supabase` on `PATH`

The normal path does not contact npm. Install the official CLI through its
supported package manager, or add it as a project development dependency. On
Windows under Node.js, use an installed official CLI or
`SUPACLOUD_SUPABASE_CLI_BIN`; the adapter will not invoke `.cmd` through a shell.

```bash
# Local schema authoring; SupaCloud credentials are not required.
supacloud supabase migration_new --name add_accounts
supacloud supabase db_diff --schema public --name add_accounts
supacloud supabase db_reset --no_seed

# Remote inspection and backup require an explicit, percent-encoded Postgres DSN.
supacloud supabase db_pull --db_url "$SUPACLOUD_DB_URL" --declarative
supacloud supabase migration_list --db_url "$SUPACLOUD_DB_URL"
supacloud supabase db_dump --db_url "$SUPACLOUD_DB_URL" --file backups/schema.sql
supacloud supabase gen_types --db_url "$SUPACLOUD_DB_URL" --schema public --file src/database.types.ts

# Remote migration application stays on the SupaCloud control plane.
supacloud supabase push --ref abc123 --dir supabase/migrations --dry_run
supacloud supabase push --ref abc123 --dir supabase/migrations
```

`supabase push` deliberately delegates to the existing
`database push_migrations` callback. It authenticates with the project-scoped
`SUPABASE_SERVICE_ROLE_KEY` or `SUPACLOUD_API_TOKEN`, uses the Management API,
and records successful migrations in `supabase_migrations.schema_migrations`.
The service-role credential is never converted into a Postgres password and is
never forwarded to the official CLI child process.

`push` requires a resolved project ref; pass `--ref` explicitly or set
`SUPACLOUD_PROJECT_REF`. A relative `--dir` is resolved against `--workdir` (or
the current directory) before dispatch, avoiding launch-directory ambiguity in
monorepos.

Official CLI child processes receive a scrubbed environment: service-role keys,
SupaCloud/API access tokens, database URLs, passwords, credentials, and secret
or key variables are removed. Returned output is also redacted. Remote
`db_pull`, `db_dump`, `migration_list`, and `gen_types` accept the DSN only as an
explicit command input because SupaCloud does not expose a long-lived database
administrator password through the control plane.

Database changes made directly through SQL consoles or `psql` do not generate a
migration file or migration-history row automatically. Treat migration files as
the source of truth, use `db_pull --declarative` to capture an intentional remote
baseline, and use `supabase push --dry_run` before applying it.

For an existing database that was already changed directly, first take a schema
dump, pull and review the remote schema in an isolated branch/worktree, and prove
that the resulting baseline/reconciliation migrations reproduce the same schema
from a clean local database. Only then record the historical files through the
controlled baseline action:

```bash
supacloud database baseline_migrations \
  --ref abc123 \
  --dir supabase/migrations \
  --dry_run

# After reviewing every listed file and receiving explicit approval:
supacloud database baseline_migrations \
  --ref abc123 \
  --dir supabase/migrations
```

`baseline_migrations` updates migration tracking through the SupaCloud
migration-mode API without executing the migration DDL. It is appropriate only
when the live schema has already been proven equivalent to those files. Never
write migration-history tables through `database query`.

For a large historical migration chain, use the local rebase workflow after
capturing and reviewing a schema-only snapshot. The command never writes the
remote database and never removes the source directory. Without `--write` it
only prints the plan:

```bash
supacloud database rebase_migrations \
  --dir supabase/migrations \
  --baseline_file backups/pre-rebase-schema.sql \
  --baseline_version 20261008000000 \
  --retain_after_version 20261001000000 \
  --output_dir supabase/migrations-rebased

supacloud database rebase_migrations \
  --dir supabase/migrations \
  --baseline_file backups/pre-rebase-schema.sql \
  --baseline_version 20261008000000 \
  --retain_after_version 20261001000000 \
  --output_dir supabase/migrations-rebased \
  --write
```

The output contains one reconstructed baseline, selected forward migrations
and `migration-rebase.manifest.json` with SHA-256 records for the complete
source history. Review the baseline for omitted data backfills, reference data,
extensions, grants, RLS, functions and triggers; replay it in a clean database
before replacing the active migration directory. Keep the original directory
as an archive until remote migration history and schema read-back are complete.

### Database SQL files

For complex SQL, pgvector queries, and transaction blocks, prefer `--file`:

```bash
supacloud database query --ref abc123 --file ./queries/vector-search.sql
```

The Management API response shape is stable:

```json
{
  "rows": [],
  "rowCount": 0,
  "command": "SELECT",
  "fields": [],
  "notices": []
}
```

### pgvector example

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

SELECT id, content
FROM documents
ORDER BY embedding <=> '[0.1,0.2,0.3]'::vector
LIMIT 5;
```

`push_migrations --dry_run` checks pending migration files and warns when pgvector usage is detected while the `vector` extension is not enabled.

### Transaction boundary

Supported:

- Migration endpoint execution is transactional.
- A single SQL request may contain its own transaction block: `BEGIN; ... COMMIT;`.

Not supported:

- Long-lived HTTP transaction APIs such as `/transaction/begin`, `/transaction/query`, and `/transaction/commit`.

Use a direct Postgres DSN with `pg`, `postgres.js`, or equivalent drivers for application-side long transactions.

### Owned command areas

- `project`: get, health, logs, api_keys, settings, tasks
- `database`
- `auth`
- `storage`
- `frontend`
- `edge_functions`
- `secrets`
- `queue`
- `task_events`
- `diagnostics`
- `gateway` (requires an admin-capable token)

The `frontend` group supports hosting management, inspection and explicit
operator rollback. Use `get_active_release` to read
the verified current artifact and activation IDs without scanning historical
archives. `list_releases` remains the paginated, full-integrity audit interface.
Publishing commands `deploy_git`, `deploy_upload`, `redeploy`, `upload_release`
and `activate_release` were removed. Use `supacloud deploy` instead.
Production mutations require exact project confirmation; read-only mode blocks
them before opening an archive or sending HTTP.

```bash
supacloud frontend list_releases --ref abc123 --id web
supacloud frontend get_active_release --ref abc123 --id web
supacloud frontend get_release --ref abc123 --id web --release_id <sha256>
supacloud frontend verify_release --ref abc123 --id web
supacloud frontend rollback --ref abc123 --id web --release_id <retained-sha256>
supacloud frontend rollback --ref abc123 --id web
```

The active snapshot is read-only and protected by the deployment lock. It
verifies the active immutable archive/tree, returns zero or one release, and
does not hash unrelated historical releases. Inspection and operator rollback
use this path. `verify_release` checks the active release together with its live
deployment URL and returns a `supacloud.frontend-release-verification.v1`
receipt containing the release identity, activation identity, HTTP status,
content type, and byte count. It reads at most 1 MiB plus the chunk crossing
that limit and cancels oversized responses. Before returning success, it reads
the active authority again; a changed release or activation returns
`ok: false` with `error_code: "STALE_AUTHORITY"`, and a failed authority
readback returns `ACTIVE_RELEASE_READBACK_FAILED`. It requires no release ID
or extra verification flags. An HTTP 404 reports that the deployment or endpoint is missing;
check the deployment and upgrade the server. There is no historical-inventory
fallback for older servers.

For immutable frontend deployments the platform retains previous artifacts.
`deploy --json` returns the application receipt for executable application delivery,
or the immutable frontend receipt for assets-only delivery. Assets-only publication
keeps the pre-upload CAS and exposes its mutation ID even on an unknown outcome.
For an operator rollback,
run `frontend rollback`; SupaCloud supplies the journal-verified previous
release, while the CLI observes current CAS and creates the mutation UUID.
An explicit `--release_id <previous-release-sha256>` remains available for a
deliberate target. Concurrent writes fail without refreshing CAS or retrying.
Release history is content-hash-sorted, so the client never guesses from its
first record. Automated deployment compensation belongs on the server, not in
client scripts that refresh CAS and retry writes.
No download, rebuild or reupload is needed. A null previous release indicates legacy/initial
deployment, not a verified rollback backup. This does not replace database or
Storage backups and never authorizes automatic database restore.

`edge_functions deploy --path <file-or-directory>` uses Bun to bundle local
TypeScript and dependencies and runs a local syntax check before upload. The
Management API applies the Edge Runtime module policy to the final server-side
artifact for CLI, Web Console, and direct API deployments alike. For
`deploy_bundle`, pass the file map as JSON, for example
`--files '{"index.ts":"export default { fetch: () => new Response(\"ok\") }"}'`.
Release automation that already has a final runtime artifact can use
`edge_functions deploy --prebundled-path <file> --expected-sha256 <sha256>`.
Use `--bytecode off|auto|required` on `deploy`, `deploy_bundle`, or `config` to
control the host-generated Bun bytecode cache for the Function. The setting
defaults to `off`, is applied during Edge Runtime preheat, and is returned in
the Function configuration. `auto` falls back to JavaScript when the final
artifact is not bytecode-compatible; `required` makes preheat fail instead.
The CLI does not upload `.jsc` files and bytecode is never compiled per
request.
The lowercase SHA-256 binds the caller-approved bytes before any request. The
CLI reads through a held regular-file descriptor and rejects file drift or
non-round-trippable UTF-8; the server independently validates the digest and
runtime policy and rejects any normalization change instead of rebundling.
This mode cannot be combined with `--path`, `--code`, or `--minify`.
Use `edge_functions source --slug <name> --version <N> --output <file>` to read back large
Function sources without depending on terminal capture limits. The CLI writes
the complete original TS/JS source code and refuses to overwrite an existing
destination. Supplying the positive version observed from `list` binds the read
to that immutable release and remains safe if the active pointer changes A→B→A.

Function release mutations use optimistic concurrency control. Before
`deploy`, `deploy_bundle`, or `activate`, run `edge_functions list` and pass the
observed non-negative integer version as `--expected-active-version <N>`. Use
`0` only for a listed legacy Function, and pass `--expected-active-version absent`
only for the first deployment of a new slug.
A stale value returns HTTP 409 before build, preheat, version creation, or
manifest activation. Successful mutations return the
`supacloud.cli.release-control.v1` receipt with `project_ref`, `slug`,
`previous_active_version`, `active_version`, `version`, and `verify_jwt`.
Transport failures, HTTP 408/5xx responses, and malformed 2xx receipts exit
non-zero as `OUTCOME_UNKNOWN`; read back `edge_functions list` before retrying.
Version `0` is reserved for a listed legacy Function's active-version CAS token.
The public CLI and Management API accept it only as the expected active version;
immutable source reads and activation targets still require positive versions.

Multi-Function release units are available through the opt-in Management
`function-releases` API; see [project release manifests](project-release-manifest.md)
for staging, atomic authority switching, recovery and in-flight semantics.

A cross-component release can be described as one immutable
`supacloud.release-control.v2` contract and checked locally before any mutation:

```bash
supacloud release contract_plan --file supacloud.release.json   --ref abc123 --environment_id production --require_current_source
```

The plan is read-only, rejects a contract bound to another project or
environment, and reports the canonical `scope_sha256`. See
[application release contract](application-release-contract.md) for the schema,
receipt and execution boundaries.

The CLI `edge_functions deploy_manifest --atomic` interface remains proposed.
Existing per-function runners must still stop on `OUTCOME_UNKNOWN` and
reconcile with `edge_functions list` plus immutable version reads. They cannot
mutate members already enrolled in a project release individually.

The readback contract stays simple for automation: `edge_functions list`
prints a JSON array whose entries have a string `slug` and a non-negative safe
integer numeric `version`; `edge_functions source` prints exactly
`{ "code": "..." }`. Release automation uses `source --version <N>` rather than
the moving active source endpoint.

### Deliberately excluded

- Server installation
- SSH diagnostics
- Tenant runtime management
- Platform metrics
- Project create/delete/pause/restore/restart

## `supacloud-admin`

Platform-scoped by default. Intended for server administrators and operators.

### Typical commands

```bash
npx @supacloud/admin status
npx @supacloud/admin ssh ping
npx @supacloud/admin ssh diagnose
npx @supacloud/admin ssh install --public_domain api.example.com --studio_domain studio.example.com
npx @supacloud/admin project list
npx @supacloud/admin project create --name my-app
```

SSH actions additionally require a pinned server host key:

```bash
export SUPACLOUD_SSH_HOST_FINGERPRINT='SHA256:...'
```

Verify that fingerprint through a trusted out-of-band channel before setting
it. Without it, `supacloud-admin` keeps HTTP administration available but leaves
all executable SSH actions disabled.

### Protected offline upgrade handoff

Protected offline upgrades use Admin's verified local artifact transport. Admin
authenticates the target Management binary, Web Console, and Edge Runtime on the
operator host against the signed manifests, checksums, sizes, source commits,
architectures, GitHub attestations, and pinned trusted root before any target
code is transferred or executed. Pin both component versions; do not use
`latest`:

```bash
npx @supacloud/admin@0.14.1 ssh upgrade \
  --version 0.60.1 \
  --edge_runtime_version 0.18.2 \
  --artifact_transport local \
  --github_proxy direct
```

The direct `sudo <bundle-runner> upgrade --asset-bundle-dir ...` handoff is not
a supported trust bootstrap: bundle code must not authenticate itself after it
already has root execution. Admin selects amd64 or arm64 from the verified SSH
preflight, transfers a protected bundle and, only after remote byte-for-byte
verification, executes that bundle's target Management runner. If the
transaction is nonterminal or recovery is incomplete, retain the reported
stage, runner, status, log, and recovery paths until read-back is complete.

The Admin-created bundle root and both component directories are canonical,
root-owned directories with mode `0700`. Every file must be a root-owned direct
regular file with mode `0600`, one link, and no symlink traversal. The fixed
layout is:

```text
<bundle>/
  management-api/
    SUPACLOUD-RELEASE.json
    SUPACLOUD-RELEASE.attestation.jsonl
    SHA256SUMS
    supacloud-linux-<arch>
    web-console-build.tar.gz
  edge-runtime/
    SUPACLOUD-RELEASE.json
    SUPACLOUD-RELEASE.attestation.jsonl
    SHA256SUMS
    supacloud-edge-runtime-linux-<arch>
```

The protected offline transport requires both exact component versions. The
server reads no GitHub release metadata and downloads no release asset. Before
upload or execution, Admin verifies the supplied provenance with its pinned
`gh` and TUF-reviewed trusted root, then checks the signed manifest,
`SHA256SUMS`, asset sizes and digests, including the target runner bytes. Before
executing that authenticated runner, the server checks the protected filesystem
identity and verifies every transferred byte against the size and digest frozen
by Admin. The target runner then repeats the offline manifest, checksum, size,
digest, and attestation verification before upgrade mutation or activation.
This path does not initialize a live Sigstore TUF client and remains strict
without TUF DNS, network access, or a pre-populated cache. A missing or outdated
verifier, an invalid embedded root, an extra file, or a component/version
mismatch fails before the upgrade transaction. Management and Edge Runtime may
come from different valid release commits; each component proves its own source
commit.

### Owned command areas

- `ssh`
- `project`: list, create, delete, pause, restore, restart, update_settings
- `platform`
