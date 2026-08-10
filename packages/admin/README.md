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

## Verified platform upgrades

Use one explicit Admin command to upgrade Management, Web Console, and an
external Edge Runtime as a single rollback-capable transaction:

```bash
npx @supacloud/admin ssh upgrade \
  --version 0.50.27 \
  --edge_runtime_version 0.16.7 \
  --github_proxy direct
```

The command supports direct root SSH and passwordless `sudo -n`. It installs
the pinned GitHub provenance verifier when needed, verifies each component
against its own release checksum and attestation, and preserves the Edge
Runtime systemd `ExecStart`, port, mode, and enabled state. Component upgrades
require persisted `EDGE_RUNTIME_MODE=external`; embedded mode is rejected
before release artifacts or services are changed.

Omitting `--edge_runtime_version` retains the Management and Web Console-only
upgrade behavior and reports that Edge Runtime was not upgraded. Caddy and
GoTrue are outside this transaction and are not replaced. After a capable
Management release is active, an exact rollback can use that active upgrader
with explicit older targets, for example:

```bash
npx @supacloud/admin ssh upgrade \
  --version 0.50.26 \
  --edge_runtime_version 0.16.6
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
supacloud-admin gateway upsert_route --ref abc123 --route_id canonical-https \
  --hosts "www.example.com" --paths "/*" --protocol http \
  --redirect_to 'https://www.example.com{http.request.uri}' --redirect_status 308
supacloud-admin gateway config --ref abc123 --rate_limit_tier pro
supacloud-admin gateway rebuild --ref abc123 --clean
```
