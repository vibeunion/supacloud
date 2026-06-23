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
supacloud-cli project task_stats
supacloud-cli project task_detail --task_id task_123
supacloud-cli queue stats --queue emails
supacloud-cli queue dlq --queue emails --limit 20
supacloud-cli task_events inspect_webhook --ref abc123
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
- `project task_detail`
- `project task_stats`
- `project task_cancel`
- `project task_retry`
- `project dlq`
- `project background_settings`
- `project update_background_settings`

Queue commands:

- `queue send`
- `queue receive`
- `queue ack`
- `queue release`
- `queue fail`
- `queue retry`
- `queue delete_message`
- `queue list_messages`
- `queue stats`
- `queue dlq`
- `queue get_settings`
- `queue update_settings`

Task event commands:

- `task_events register_webhook`
- `task_events unregister_webhook`
- `task_events inspect_webhook`

Gateway / Caddy commands (require admin privileges; config is injected via the Caddy JSON Admin API):

- `gateway routes` — list custom gateway routes (reverse_proxy / static sites)
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
supacloud-cli gateway config --ref abc123 --rate_limit_tier pro
supacloud-cli gateway rebuild --ref abc123 --clean
```

For server installation, SSH diagnostics, and tenant administration, use `@supacloud/admin`.
