# @supacloud/cli

Project-scoped CLI for SupaCloud users.

`supacloud` defaults to the current workspace's project context. If you do not pass explicit flags, it tries to auto-link from `.env`:

- `SUPABASE_URL` or `SUPACLOUD_API_URL`
- `SUPABASE_SERVICE_ROLE_KEY` or `SUPACLOUD_API_TOKEN`

Examples:

```bash
npx @supacloud/cli status
npx @supacloud/cli project get
npx @supacloud/cli database query --sql "select now()"
npx @supacloud/cli frontend list --ref abc123
```

For server installation, SSH diagnostics, and tenant administration, use `@supacloud/admin`.
