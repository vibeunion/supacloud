# SupaCloud CLI Guide

SupaCloud exposes three explicit local command surfaces with strict ownership boundaries:

- `@supacloud/cli` / `supacloud-cli`
- `@supacloud/admin` / `supacloud-admin`
- the optional `supacloud` npm package / `supacloudctl`, whose normal dispatch is local-only; `supacloudctl check-update [cli|admin]` explicitly queries npm without downloading or executing `latest`

The bare `supacloud` command is not a local CLI compatibility alias. It is the
compiled active server binary installed at `/usr/local/bin/supacloud`; do not
use an installed prior release to execute a target release's upgrade contract.
Project work uses `supacloud-cli`, platform upgrades use `supacloud-admin`, and
the optional local umbrella command is `supacloudctl`.

```text
supacloud-cli        project-scoped user/developer CLI
supacloud-admin      server and platform administration CLI
supacloudctl         local dispatcher for the two installed CLIs
/usr/local/bin/supacloud  compiled server binary (not a CLI alias)
```

## `supacloud-cli`

Project-scoped by default. Intended for project users and developers.

### Context model

- Prefers the current workspace `.env`
- Reads `SUPABASE_URL` or `SUPACLOUD_API_URL`
- Reads `SUPABASE_SERVICE_ROLE_KEY` or `SUPACLOUD_API_TOKEN`
- Reads `SUPACLOUD_PROJECT_REF` when the ref cannot be inferred
- Can still accept explicit `--ref` when needed

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

supacloud-cli status
supacloud-cli deploy
supacloud-cli project get
supacloud-cli project logs --log_type database
supacloud-cli database query --sql "select now()"
supacloud-cli database query --ref abc123 --file ./queries/vector-search.sql
supacloud-cli database push_migrations --ref abc123 --dir supabase/migrations --dry_run
supacloud-cli supabase migration_new --name add_accounts
supacloud-cli supabase db_diff --schema public --name add_accounts
supacloud-cli supabase push --ref abc123 --dir supabase/migrations --dry_run
supacloud-cli frontend list --ref abc123
supacloud-cli frontend list_releases --ref abc123 --id web
supacloud-cli frontend upload_release --ref abc123 --id web --zip_path ./dist.zip
```

### One-command deploy

`supacloud-cli deploy` is the normal developer path for a linked application. It
supports a frontend and backend living in separate directories. Frontend targets
use immutable static releases; `edge_function` targets use the existing verified
Edge Function bundle protocol. The command runs the target build, publishes only
that target, and reads the final identity back.

### Remote test development sync

For a dedicated test server, use `dev` to synchronize source files over SSH and
reload only the affected development target. This path is separate from
immutable Function releases and is rejected for production environments.

```bash
supacloud-cli --env test dev sync --target functions --function api
supacloud-cli --env test dev sync --target db
supacloud-cli --env test dev watch --target project
supacloud-cli --env test dev status
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
supacloud-cli --env test dev migrate
supacloud-cli --env test dev migrate --apply
```

Simple single-frontend projects usually need no file. Monorepos should add a
repository-root `supacloud.json`:

```json
{
  "defaultTarget": "web",
  "targets": {
    "web": {
      "type": "frontend",
      "root": "apps/web",
      "id": "web",
      "buildCommand": "bun run build",
      "outputDirectory": "dist"
    },
    "api": {
      "type": "edge_function",
      "root": "apps/api",
      "slug": "api",
      "buildCommand": "bun run bundle",
      "bundleDirectory": "dist",
      "entrypoint": "index.ts",
      "verifyJwt": true,
      "minify": true
    }
  }
}
```

```bash
# From a target workspace, the target is selected automatically.
cd apps/web
supacloud-cli deploy
cd ../api
supacloud-cli deploy

# From the repository root, select a target explicitly.
supacloud-cli deploy --target web
supacloud-cli deploy --target api

# Inspect the resolved plan without building or writing remotely.
supacloud-cli deploy --target web --dry_run

# Publish an output directory already built by CI.
supacloud-cli deploy --target web --skip_build --output_dir dist
```

When multiple targets exist and the command runs at the repository root, it
fails closed unless `defaultTarget` or `--target` is provided. Running inside a
target directory selects the deepest matching `root`. Relative output and bundle
directories are resolved against that target root, while lockfiles are detected
from the target root up to the repository root.

The legacy shape remains supported:

```json
{
  "frontend": {
    "id": "web",
    "root": "apps/web",
    "buildCommand": "bun run build",
    "outputDirectory": "dist"
  }
}
```

Production profiles retain the standard explicit confirmation gate:

```bash
supacloud-cli --env production --confirm-production abc123 deploy
```

Both `--key value` and `--key=value` syntax are supported. `supacloud-cli status`
reports configuration, Management API connectivity, and authentication as
separate checks, and returns a non-zero exit code when a required check fails.

One-off execution without global install:

```bash
npm exec --package @supacloud/cli -- supacloud-cli status
```

### Application framework commands

Local commands for the application framework (`@supacloud/app` +
`@supacloud/compiler`) and database governance (`@supacloud/db`). They run
without a Management API context and never mutate the database.

```bash
# scaffold modules, commands, queries and controllers
supacloud-cli app generate --kind module --name case
supacloud-cli app generate --kind command --name accept --module case

# compile decorator metadata into static factories + app.manifest.json
supacloud-cli app compile --root . --out_dir generated --strict

# validate only (no files written), print the module dependency tree,
# or explain a single provider/command/controller
supacloud-cli app check
supacloud-cli app graph --format json
supacloud-cli app explain --target CaseService
supacloud-cli app export-tools
supacloud-cli app export-tools --format json

# SQL governance over defineDatabaseModule sources
supacloud-cli db lint --module_file db/modules.ts
supacloud-cli db explain --target public.case_create

# read-only catalog reconcile against a live database
supacloud-cli db module_check --module_file db/modules.ts --database_url "$DATABASE_URL"

# or reconcile against a local SupaCloud Lite project (delegates to supacloud-lite db check)
supacloud-cli db module_check --lite --project_dir .
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

### AI/Agent Skill

`@supacloud/cli` ships a `supacloud-cli` Skill for Codex and other Skill-compatible
agents. The human guide remains this document; the Skill converts the same
rules into runtime instructions so an agent does not default to direct remote
SQL or Management API writes.

```bash
# Inspect the packaged source and default Codex destination.
supacloud-cli ai show_skill

# Preview installation; no project credentials are needed.
supacloud-cli ai install_skill --dry_run

# Install into $CODEX_HOME/skills or ~/.codex/skills.
supacloud-cli ai install_skill

# Install into another agent's explicit Skill root.
supacloud-cli ai install_skill --target /path/to/skills
```

Installation is idempotent. If an existing `supacloud-cli` Skill differs, the
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
through `supacloud-cli lite`. The main CLI adapter is local-only: it does not
use Management API credentials, the official Supabase CLI, or a Postgres DSN
for the PGlite state directory.

```bash
supacloud-cli lite migrate --project_dir .
supacloud-cli lite status --project_dir .
supacloud-cli lite db_diff --project_dir . --file add_accounts
supacloud-cli lite db_pull --project_dir . --file remote_schema
supacloud-cli lite gen_types --project_dir . --output src/database.types.ts
supacloud-cli lite snapshot_create --project_dir . --output backups/lite.tar.gz
supacloud-cli lite doctor --project_dir . --json
supacloud-cli lite start --project_dir . --port 54321
```

Executable resolution is `SUPACLOUD_LITE_CLI_BIN`, then the project-local
`@supacloud/lite` launcher, then `supacloud-lite` on `PATH`. The `supabase`
module remains reserved for the official Supabase CLI and Management-backed
remote project operations.

### Official Supabase CLI adapter

`supacloud-cli supabase` is a thin, allowlisted adapter around the official
open-source Supabase CLI. SupaCloud does not fork or vendor the upstream CLI.
The adapter resolves the executable in this order:

1. `SUPACLOUD_SUPABASE_CLI_BIN` (an explicit executable path)
2. `SUPABASE_CLI_VERSION=2.110.0` (explicit opt-in to a pinned Bun/npm package runner)
3. `<workdir>/node_modules/supabase`
4. `supabase` on `PATH`

The normal path does not contact npm. Install the official CLI through its
supported package manager, or add it as a project development dependency. On
Windows under Node.js, use an installed official CLI or
`SUPACLOUD_SUPABASE_CLI_BIN`; the adapter will not invoke `.cmd` through a shell.

```bash
# Local schema authoring; SupaCloud credentials are not required.
supacloud-cli supabase migration_new --name add_accounts
supacloud-cli supabase db_diff --schema public --name add_accounts
supacloud-cli supabase db_reset --no_seed

# Remote inspection and backup require an explicit, percent-encoded Postgres DSN.
supacloud-cli supabase db_pull --db_url "$SUPACLOUD_DB_URL" --declarative
supacloud-cli supabase migration_list --db_url "$SUPACLOUD_DB_URL"
supacloud-cli supabase db_dump --db_url "$SUPACLOUD_DB_URL" --file backups/schema.sql
supacloud-cli supabase gen_types --db_url "$SUPACLOUD_DB_URL" --schema public --file src/database.types.ts

# Remote migration application stays on the SupaCloud control plane.
supacloud-cli supabase push --ref abc123 --dir supabase/migrations --dry_run
supacloud-cli supabase push --ref abc123 --dir supabase/migrations
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
supacloud-cli database baseline_migrations \
  --ref abc123 \
  --dir supabase/migrations \
  --dry_run

# After reviewing every listed file and receiving explicit approval:
supacloud-cli database baseline_migrations \
  --ref abc123 \
  --dir supabase/migrations
```

`baseline_migrations` updates migration tracking through the SupaCloud
migration-mode API without executing the migration DDL. It is appropriate only
when the live schema has already been proven equivalent to those files. Never
write migration-history tables through `database query`.

### Database SQL files

For complex SQL, pgvector queries, and transaction blocks, prefer `--file`:

```bash
supacloud-cli database query --ref abc123 --file ./queries/vector-search.sql
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

The `frontend` group supports both the existing deployment/Git/legacy ZIP
actions and immutable prebuilt release control. Use `list_releases` to read the
active release and activation IDs, `upload_release` to stream a local ZIP bound
to its SHA-256, and `activate_release` with the observed IDs plus a retry-stable
UUIDv4 mutation ID. The CLI verifies upload and activation readback before
reporting success. Production mutations require exact project confirmation;
read-only mode blocks them before opening the archive or sending HTTP.

```bash
supacloud-cli frontend list_releases --ref abc123 --id web
supacloud-cli frontend get_release --ref abc123 --id web --release_id <sha256>
supacloud-cli frontend activate_release --ref abc123 --id web \
  --release_id <sha256> \
  --expected_active_release_id <current-sha256-or-absent> \
  --expected_activation_id <current-uuid-v4-or-absent> \
  --mutation_id <retry-stable-uuid-v4>
```

`edge_functions deploy --path <file-or-directory>` uses Bun to bundle local
TypeScript and dependencies and runs a local syntax check before upload. The
Management API applies the Edge Runtime module policy to the final server-side
artifact for CLI, Web Console, and direct API deployments alike. For
`deploy_bundle`, pass the file map as JSON, for example
`--files '{"index.ts":"export default { fetch: () => new Response(\"ok\") }"}'`.
Release automation that already has a final runtime artifact can use
`edge_functions deploy --prebundled-path <file> --expected-sha256 <sha256>`.
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

Multi-Function atomic deployment is not currently available. Release runners
must deploy each Function with its observed version and activation identity,
stop on `OUTCOME_UNKNOWN`, and reconcile with `edge_functions list` plus an
immutable `source --version <N>` read before retrying or applying reverse-order
CAS compensation. The `edge_functions deploy_manifest --atomic` interface in
the release-control automation specification is a proposed contract.

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
