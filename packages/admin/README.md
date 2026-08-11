# @supacloud/admin

Platform administration CLI for SupaCloud operators.

`supacloud-admin` is intended for server installation, SSH diagnostics, tenant runtime management, and platform-wide project administration.

Typical environment variables:

- `SUPACLOUD_ENV` — environment identity such as `test` or `production`
- `SUPACLOUD_READ_ONLY=true` — block every remote write
- `SUPACLOUD_HOST`
- `SUPACLOUD_SSH_KEY` or `SUPACLOUD_SSH_PASS`
- `SUPACLOUD_SSH_HOST_FINGERPRINT` — required for SSH actions, in OpenSSH `SHA256:<base64>` form
- `SUPACLOUD_API_URL`
- `SUPACLOUD_API_TOKEN`

## Environment selection and production confirmation

Use `--env <name>` to load `.env.supacloud.<name>` from the current directory,
or `--env-file <path>` to load one exact file. Every selected file must declare
`SUPACLOUD_ENV`; a named file's declared value must match the selector. Global
flags may appear before or after the command.

Selected files are atomic context sources: Admin does not fill missing API,
project, SSH, credential, or safety values from the process environment or a
different dotenv file. Without a selector, a complete process context declaring
`SUPACLOUD_ENV` is used as one source. If that process context is incomplete,
`SUPACLOUD_ENV` selects `.env.supacloud.<value>` instead. The legacy `.env`
fallback remains available only when no Admin context variables are present in
the process.

Production writes require `--confirm-production` before any HTTP or SSH action:

- Project-scoped writes use the exact requested project ref. If the selected
  profile declares `SUPACLOUD_PROJECT_REF`, an explicit different ref is
  rejected for both reads and writes.
- Platform API writes that genuinely have no project ref use
  `platform:<API host>`, for example `platform:management.example.com`.
- SSH writes that genuinely have no project ref use `host:<SSH host[:port]>`,
  for example `host:production.example.com:2201`.

A generic value such as `production` is never accepted. Project-scoped actions
that omit a required ref do not fall back to a platform or host confirmation.
`SUPACLOUD_READ_ONLY=true` blocks every remote write in every environment,
including when it is set only in the process environment. Remote writes also
require an explicit `SUPACLOUD_ENV`; unclassified process and legacy dotenv
contexts remain usable for read-only actions but cannot mutate remote state.

Management API URLs must be origin-and-path URLs without credentials, query
strings, or fragments. This prevents URL-embedded secrets from being sent to a
remote target or displayed by `status` and `--help`.

```bash
npx @supacloud/admin --env test status
npx @supacloud/admin --env production project delete \
  --ref abc123 --confirm-production abc123
npx @supacloud/admin --env production ssh upgrade \
  --version 0.50.31 --edge_runtime_version 0.16.8 \
  --confirm-production host:production.example.com:2201
```

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
npx @supacloud/admin ssh versions
npx @supacloud/admin ssh diagnose
npx @supacloud/admin project create --name my-app --domain example.com
npx @supacloud/admin project list
npx @supacloud/admin project services --ref abc123
npx @supacloud/admin project service_control --ref abc123 --service gotrue --service_action stop
```

`ssh versions` emits JSON with `schema_version: 1` and fixed
`management_api`, `edge_runtime`, `caddy`, and `web_console` component fields.
Each component reports `status` as `ok`, `unknown`, or `error`; a failed probe
never substitutes a guessed version. Binary evidence is bound to the active
systemd `ExecStart`, and Web Console evidence comes from its component marker
plus an explicit `tree_sha256` digest.

## Verified platform upgrades

Use one explicit Admin command to upgrade Management, Web Console, and an
external Edge Runtime as a single rollback-capable transaction:

```bash
npx @supacloud/admin ssh upgrade \
  --version 0.50.31 \
  --edge_runtime_version 0.16.8 \
  --artifact_transport local \
  --github_proxy direct
```

Local artifact transport downloads exact releases directly on the Admin host,
verifies their signed release manifests, checksums, sizes, provenance, source
commit, and architecture, then transfers them through an atomic SFTP staging
directory. The server takes root ownership, repeats offline verification, and
runs the uploaded target Management binary without GitHub or Sigstore TUF
egress or a third-party proxy. Admin and Management use the same reviewed,
digest-pinned Sigstore Public Good trusted root via `--custom-trusted-root`, so
the offline handoff does not depend on a pre-populated TUF cache. The server
reuses an installed `gh` only when it supports all required strict attestation
flags. Otherwise Admin transfers a pinned temporary Linux `gh` verifier that is
removed with the staging directory and never replaces `/usr/local/bin/gh`.

The command supports direct root SSH and passwordless `sudo -n`. The transaction
runs in a uniquely named transient systemd unit with protected atomic status
records; Admin polls that record without tying the transaction to a long-lived
SSH channel. It preserves the Edge Runtime systemd `ExecStart`, port, mode, and
enabled state. Component upgrades require persisted `EDGE_RUNTIME_MODE=external`;
embedded mode is rejected before release artifacts or services are changed.
Local, remote, and direct server upgrades share one nonblocking host-wide lock.

Admin observes the remote transaction for up to 30 minutes. Reaching that
deadline stops only local observation; it does not stop, clean up, or mark the
remote transaction as failed. The CLI reports the unit, stage, status, log, and
upload-drop paths for reconciliation. Inspect that evidence before retrying and
do not retry blindly while the remote transaction may still be running.

`--artifact_transport local` accepts only `--github_proxy direct` or `none` and
clears proxy environment variables on both hosts. The legacy server-download
path remains available as `--artifact_transport remote`.

With `--artifact_transport remote` (the default), omitting
`--edge_runtime_version` retains the Management and Web Console-only upgrade
behavior and reports that Edge Runtime was not upgraded. Local transport
requires exact Management and Edge Runtime versions. Caddy and GoTrue are
outside this transaction and are not replaced. After a capable Management
release is active, an exact rollback can use that active upgrader with explicit
older targets, for example:

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
- `project services` — read-only project service inventory
- `project service_control` — constrained project service lifecycle control

Service control accepts canonical service names only. `postgrest` supports
`start`, `stop`, `restart`, `pause`, `resume`, and `status`; `gotrue`, `storage`,
`postgresql`, `realtime`, and `gateway` support `start`, `stop`, and `restart`.
The command calls only the Management API's existing
`/v1/projects/{ref}/services` routes. A non-2xx response, a `success: false`
receipt, or a response that does not match the requested service and action
exits non-zero. Successful inventory and control responses are emitted as JSON
with `project_ref` for strict read-back.

The Management API remains authoritative for SupAuth ownership. Controlling
GoTrue on a shared-auth project fails with `AUTH_RUNTIME_MANAGED_BY_OWNER`;
the CLI does not redirect the operation to the owner project. Supply
`SUPACLOUD_API_TOKEN` through the environment only; service-control commands do
not accept credential flags.

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
