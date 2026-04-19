# @supacloud/admin

Platform administration CLI for SupaCloud operators.

`supacloud-admin` is intended for server installation, SSH diagnostics, tenant runtime management, and platform-wide project administration.

Typical environment variables:

- `SUPACLOUD_HOST`
- `SUPACLOUD_SSH_KEY` or `SUPACLOUD_SSH_PASS`
- `SUPACLOUD_API_URL`
- `SUPACLOUD_API_TOKEN`

Examples:

```bash
npx @supacloud/admin status
npx @supacloud/admin ssh ping
npx @supacloud/admin ssh diagnose
npx @supacloud/admin project create --name my-app
npx @supacloud/admin project list
```

Project commands owned by this CLI:

- `project list`
- `project create`
- `project delete`
- `project pause`
- `project restore`
- `project restart`
- `project update_settings`
