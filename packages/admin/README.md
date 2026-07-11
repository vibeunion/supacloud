# @supacloud/admin

Platform administration CLI for SupaCloud operators.

`supacloud-admin` is intended for server installation, SSH diagnostics, tenant runtime management, and platform-wide project administration.

Typical environment variables:

- `SUPACLOUD_HOST`
- `SUPACLOUD_SSH_KEY` or `SUPACLOUD_SSH_PASS`
- `SUPACLOUD_SSH_HOST_FINGERPRINT` — required for SSH actions, in OpenSSH `SHA256:<base64>` form
- `SUPACLOUD_API_URL`
- `SUPACLOUD_API_TOKEN`

SSH host keys are fail-closed: setting `SUPACLOUD_HOST` and credentials is not
enough to enable SSH actions. Obtain the fingerprint through a trusted channel,
compare it out of band, then set it explicitly. For example, the discovery
command below is useful only after independently authenticating its result:

```bash
ssh-keyscan -p 22 server.example.com | ssh-keygen -lf -
export SUPACLOUD_SSH_HOST_FINGERPRINT='SHA256:...'
```

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

Gateway / Caddy commands (config is injected via the Caddy JSON Admin API; requires admin privileges):

- `gateway routes` — list custom gateway routes
- `gateway upsert_route` — create or replace a route
- `gateway update_route` — replace a route by id
- `gateway delete_route` — remove a route by id
- `gateway config` — update rate-limit tier, CORS origins, or JWT settings
- `gateway get_certificate` / `gateway update_certificate`
- `gateway issue_certificate` — issue or renew with lego
- `gateway deploy_certificate` — deploy an existing PEM cert/key pair
- `gateway rebuild` — rebuild all tenant gateway configs (`--clean` for a full rebuild)
- `gateway custom_hostname` / `gateway set_custom_hostname` / `gateway delete_custom_hostname` / `gateway verify_custom_hostname`

```bash
supacloud-admin gateway routes --ref abc123
supacloud-admin gateway upsert_route --ref abc123 --route_id webhook \
  --hosts "api.example.com" --paths "/webhook/*" --upstream 10.0.0.5:8080
supacloud-admin gateway config --ref abc123 --rate_limit_tier pro
supacloud-admin gateway rebuild --ref abc123 --clean
```
