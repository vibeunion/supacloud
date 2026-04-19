# SupaCloud CLI Guide

SupaCloud now exposes two human-facing CLIs with strict ownership boundaries:

- `@supacloud/cli` / `supacloud`
- `@supacloud/admin` / `supacloud-admin`

## `supacloud`

Project-scoped by default. Intended for project users and developers.

### Context model

- Prefers the current workspace `.env`
- Reads `SUPABASE_URL` or `SUPACLOUD_API_URL`
- Reads `SUPABASE_SERVICE_ROLE_KEY` or `SUPACLOUD_API_TOKEN`
- Can still accept explicit `--ref` when needed

### Typical commands

```bash
npx @supacloud/cli status
npx @supacloud/cli project get
npx @supacloud/cli project logs --log_type database
npx @supacloud/cli database query --sql "select now()"
npx @supacloud/cli frontend list --ref abc123
```

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
