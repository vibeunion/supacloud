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
npx @supacloud/admin project create --name my-app --domain example.com \
  --env_file /secure/path/.env.project-credentials.test --environment test
npx @supacloud/admin project list
npx @supacloud/admin project services --ref abc123
npx @supacloud/admin project runtime_snapshot --ref abc123
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
outside this transaction and are not replaced.

The remote transport allows the same 30-minute transaction window plus bounded
verifier/bootstrap downloads: 42 minutes for direct GitHub access, or 52
minutes when each download may try direct GitHub before an explicit proxy. If
the SSH command times out or its stream fails after dispatch, Admin reports
`OUTCOME_UNKNOWN` and does not issue client-side helper cleanup. The remote
command may finish later and then run its own cleanup. Reconcile the reported
helper and trusted-root paths and read back deployed versions before deciding
whether to retry.

After a capable Management release is active, an exact rollback can use that
active upgrader with explicit older targets, for example:

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
- `project runtime_snapshot` — strict read-only runtime revision and PostgREST attestation snapshot
- `project service_control` — constrained project service lifecycle control

`project create` never prints project credentials. Pass an absolute
`--env_file` path to explicitly request one-time service-role delivery. This
mode requires both a complete bare `--api_domain` (or bare base `--domain`)
and an exact `--environment test|production`; invalid or missing bindings fail
before the remote project mutation. `--environment` is used only in the local
credential file and is never sent to the Management API. Credential delivery is
supported only on Linux, where Admin holds the canonical parent directory open
and performs create, verification, and cleanup through `/proc/self/fd`. macOS
and Windows fail with `ENV_FILE_PLATFORM_UNSUPPORTED` before creating a file or
requesting remote credentials. On Linux, the target is exclusively reserved at
mode `0600` before the remote mutation. The direct parent must be owned by the
Admin process user. Every ancestor must be owned by root or that user and must
not grant group/world write access; paths below writable sticky directories
such as `/tmp` are rejected. Parent ownership, mode, and device/inode identity,
plus file ownership, mode, and device/inode identity, are checked before and
after writing through the held parent descriptor. The file and parent directory
are synced before success is reported.
The response API URL and project name must exactly match the request binding;
the origin comparison includes the port. Existing files, symlinks, replaced
parents, non-canonical paths, and missing or untrusted directories are rejected.
The recommended name is
`.env.project-credentials.<environment>`; verify that the target repository
ignores it before running the command (SupaCloud's own `.env.*` rule does).
This is an application credential file, not a SupaCloud Admin/Management
profile: Admin rejects it before registering HTTP tools, so never select it
with `supacloud-admin --env` or `--env-file`. Selected Admin files that contain
project application credentials must also contain an explicit Management API
URL and `SUPACLOUD_API_TOKEN`; Admin never substitutes the service-role key.
The generated file contains only `SUPACLOUD_ENV`, `SUPACLOUD_PROJECT_REF`,
`SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`; the public project origin is deliberately not
written as `SUPACLOUD_API_URL`, which Admin reserves for the Management API.
The success receipt marks `env_file_scope` as `project_application`. Standard
output otherwise contains only credential-free fields. Supply
`SUPACLOUD_API_TOKEN` through the process environment, never as a command
argument.

If the remote project is created but local env writing fails, the error receipt
retains only the safe project ref and API URL, sets `remote_created: true` and
`retry_safe: false`, and never includes the credential. A
`credential_file_state: "absent"` receipt confirms cleanup and includes
`credentials_written: false`. A `credential_file_state: "unknown"` receipt
omits `credentials_written`; treat the target path as secret-bearing until an
operator securely removes it or completes credential recovery/rotation. Repair
the local path only after reading back the existing project and following that
recovery flow; never blindly retry project creation.

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

Create a completed full physical backup before a release with:

```bash
supacloud-admin platform create_backup --ref abc123 --backup_type full
```

The command reads the physical backup inventory before the write and performs
one bounded reconciliation read after every mutation attempt. It exits non-zero
unless the API confirms success and the inventory contains exactly one new,
completed full backup with a nonzero size. The Management API rejects unknown
project refs and resolves inventory from the persisted project database name.
The JSON receipt contains only the project ref, requested type, backup ID,
database, timestamps, and size. `platform list_backups --ref abc123` applies the
same strict, sanitized inventory validation without creating a backup.

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
