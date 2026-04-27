# @supacloud/cli

Project-scoped CLI for SupaCloud users.

Use the explicit `supacloud-cli` command for project workflows. The old `supacloud`
binary name is kept as a compatibility alias only; it is easy to confuse with the
server binary installed at `/usr/local/bin/supacloud`.

Install:

```bash
npm install -g @supacloud/cli
supacloud-cli status
```

One-off execution:

```bash
npm exec --package @supacloud/cli -- supacloud-cli status
```

`supacloud-cli` defaults to the current workspace's project context. If you do not pass explicit flags, it tries to auto-link from `.env`:

- `SUPABASE_URL` or `SUPACLOUD_API_URL`
- `SUPABASE_SERVICE_ROLE_KEY` or `SUPACLOUD_API_TOKEN`

Examples:

```bash
supacloud-cli status
supacloud-cli project get
supacloud-cli project logs --log_type database
supacloud-cli database query --sql "select now()"
supacloud-cli database query --ref abc123 --file ./queries/vector-search.sql
supacloud-cli database push_migrations --ref abc123 --dir supabase/migrations --dry_run
supacloud-cli frontend list --ref abc123
```

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

For server installation, SSH diagnostics, and tenant administration, use `@supacloud/admin`.
