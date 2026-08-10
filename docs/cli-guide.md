# SupaCloud CLI Guide

SupaCloud exposes three explicit local command surfaces with strict ownership boundaries:

- `@supacloud/cli` / `supacloud-cli`
- `@supacloud/admin` / `supacloud-admin`
- the optional `supacloud` npm package / `supacloudctl`, whose normal dispatch is local-only; `supacloudctl check-update [cli|admin]` explicitly queries npm without downloading or executing `latest`

The bare `supacloud` command is not a local CLI compatibility alias. It is the
compiled server binary installed at `/usr/local/bin/supacloud`; use it only for
server lifecycle commands such as `sudo supacloud upgrade --yes`. Project work
uses `supacloud-cli`, platform administration uses `supacloud-admin`, and the
optional local umbrella command is `supacloudctl`.

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
supacloud-cli project get
supacloud-cli project logs --log_type database
supacloud-cli database query --sql "select now()"
supacloud-cli database query --ref abc123 --file ./queries/vector-search.sql
supacloud-cli database push_migrations --ref abc123 --dir supabase/migrations --dry_run
supacloud-cli supabase migration_new --name add_accounts
supacloud-cli supabase db_diff --schema public --name add_accounts
supacloud-cli supabase push --ref abc123 --dir supabase/migrations --dry_run
supacloud-cli frontend list --ref abc123
```

Both `--key value` and `--key=value` syntax are supported. `supacloud-cli status`
reports configuration, Management API connectivity, and authentication as
separate checks, and returns a non-zero exit code when a required check fails.

One-off execution without global install:

```bash
npm exec --package @supacloud/cli -- supacloud-cli status
```

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

`edge_functions deploy --path <file-or-directory>` uses Bun to bundle local
TypeScript and dependencies and runs a local syntax check before upload. The
Management API applies the Edge Runtime module policy to the final server-side
artifact for CLI, Web Console, and direct API deployments alike. For
`deploy_bundle`, pass the file map as JSON, for example
`--files '{"index.ts":"export default { fetch: () => new Response(\"ok\") }"}'`.
Use `edge_functions source --slug <name> --output <file>` to read back large
Function sources without depending on terminal capture limits. The CLI writes
the complete original TS/JS source code and refuses to overwrite an existing
destination.

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

The installed server binary provides the supported handoff for a release bundle
that an administrator has already placed on the server. Pin both component
versions; do not use `latest` or an inferred Edge Runtime version:

```bash
sudo /usr/local/bin/supacloud upgrade --yes \
  --target-version 0.50.31 \
  --edge-runtime-version 0.16.8 \
  --asset-bundle-dir /var/lib/supacloud/upgrade-bundles/release-20260810
```

The bundle root and both component directories must be canonical, root-owned
directories with mode `0700`. Every file must be a root-owned direct regular
file with mode `0600`, one link, and no symlink traversal. The fixed layout is:

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

Omit `edge-runtime/` and `--edge-runtime-version` together for a
Management/Web Console-only transaction. When an Edge Runtime version is
specified, both are mandatory. The offline path reads no GitHub release
metadata and downloads no release asset. It verifies the supplied provenance
bundles locally with `gh attestation verify`, then checks the signed manifest,
`SHA256SUMS`, exact asset size and digest before staging anything. A missing or
outdated verifier, an extra file, or a component/version mismatch fails before
the upgrade transaction. Management and Edge Runtime may come from different
valid release commits; each component proves its own source commit.

### Owned command areas

- `ssh`
- `project`: list, create, delete, pause, restore, restart, update_settings
- `platform`
