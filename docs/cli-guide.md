# SupaCloud CLI Guide

SupaCloud now exposes two human-facing CLIs with strict ownership boundaries:

- `@supacloud/cli` / `supacloud-cli`
- `@supacloud/admin` / `supacloud-admin`

Avoid using the bare `supacloud` name for project workflows. SupaCloud also ships
a server binary named `supacloud`, usually installed at `/usr/local/bin/supacloud`,
so the explicit project command is `supacloud-cli`.

## `supacloud-cli`

Project-scoped by default. Intended for project users and developers.

### Context model

- Prefers the current workspace `.env`
- Reads `SUPABASE_URL` or `SUPACLOUD_API_URL`
- Reads `SUPABASE_SERVICE_ROLE_KEY` or `SUPACLOUD_API_TOKEN`
- Can still accept explicit `--ref` when needed

When auto-linking from `SUPABASE_URL`, the CLI accepts tenant API domains and
derives the matching Management API host. For example,
`https://api.example.com` maps to `https://studio.example.com`, and
`https://abc123.api.example.com` maps to `https://studio-abc123.example.com`.
Set `SUPACLOUD_API_URL` explicitly to override this inference.

### Typical commands

```bash
npm install -g @supacloud/cli

supacloud-cli status
supacloud-cli project get
supacloud-cli project logs --log_type database
supacloud-cli database query --sql "select now()"
supacloud-cli database query --ref abc123 --file ./queries/vector-search.sql
supacloud-cli database push_migrations --ref abc123 --dir supabase/migrations --dry_run
supacloud-cli frontend list --ref abc123
```

One-off execution without global install:

```bash
npm exec --package @supacloud/cli -- supacloud-cli status
```

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

### Owned command areas

- `ssh`
- `project`: list, create, delete, pause, restore, restart, update_settings
- `platform`
