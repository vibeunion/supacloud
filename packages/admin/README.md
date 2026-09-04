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

Immutable prebuilt frontend releases use a content-addressed ZIP and an explicit
compare-and-swap activation. Upload and activation are separate writes, and
production requires the exact project ref confirmation:

```bash
supacloud-admin frontend list_releases --ref abc123 --id web
supacloud-admin frontend get_release --ref abc123 --id web --release_id <sha256>
supacloud-admin frontend upload_release --ref abc123 --id web \
  --zip_path /secure/site.zip --confirm-production abc123
supacloud-admin frontend activate_release --ref abc123 --id web \
  --release_id <sha256> --expected_active_release_id absent \
  --expected_activation_id absent --mutation_id <uuid-v4> \
  --confirm-production abc123
```

The CLI reads the archive through a no-follow file descriptor, verifies its
identity and SHA-256 before upload, validates bounded Management API receipts,
and reads the immutable release or active inventory back before reporting
success. Reuse the same `mutation_id` only when retrying the exact activation.
Listing and release readback work on every Management API platform. Upload and
activation mutations require the Linux held-directory-FD implementation; on
other platforms, Management API returns HTTP 503 before it reads the upload
body, creates release directories, or writes a mutation journal.

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
npx @supacloud/admin ssh upgrade_status --transaction_id 11111111-1111-4111-8111-111111111111
npx @supacloud/admin ssh backup_cleanup_plan --before 2026-09-03 --keep_latest 2
npx @supacloud/admin ssh backup_cleanup_apply --before 2026-09-03 --keep_latest 2 \
  --plan_sha256 <plan_sha256>
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
plus an explicit `tree_sha256` digest. An `unknown` component remains a valid
inventory result, while any `error` component makes the CLI exit non-zero after
printing the structured report.

## Managed rollback backup cleanup

Use the two-step SSH cleanup flow when old platform rollback directories consume
disk space:

```bash
npx @supacloud/admin ssh backup_cleanup_plan \
  --before 2026-09-03 --keep_latest 2
# review plan_sha256 and the candidate list
npx @supacloud/admin ssh backup_cleanup_apply \
  --before 2026-09-03 --keep_latest 2 \
  --plan_sha256 <plan_sha256>
```

The plan is read-only. Apply requires the exact digest from the plan and
recomputes it immediately before deletion. Only completed `committed` or
`rolled_back` transaction directories directly under
`/opt/supacloud/backups` are eligible; the newest `keep_latest` directories
are retained, and candidates must be older than `before`. Symlinks,
mountpoints, malformed transaction names, missing status files, and every path
outside the managed backup root are refused. Production runs also require the
normal `--confirm-production host:<ssh-host>[:port]` confirmation.

## Verified platform upgrades

Use one explicit Admin command to upgrade Management, Web Console, and an
external Edge Runtime as a single rollback-capable transaction:

```bash
npx @supacloud/admin ssh upgrade \
  --version 0.61.4 \
  --edge_runtime_version 0.18.2 \
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

Local artifact upgrades require Management 0.61.4 or newer. After stopping the
old Management service and before writing runtime secrets or running
`--init-db`, the target binary verifies that `DATABASE_URL` identifies the
Management control-plane database, rejects a registered tenant database, and
creates a verified custom-format PostgreSQL archive. Backups and their private
receipts are stored under
`/var/lib/supacloud/backups/control-plane-upgrades/<backup-id>/`; the five most
recent trusted backups are retained.

The inspection transaction remains open while `pg_dump` imports its exported
snapshot, so a different PostgreSQL server cannot satisfy the dump step. The
root process reserves the private archive first; the `postgres` identity receives
only that inherited output descriptor and never gains path access to the
root-only backup directory.

The inspection transaction also keeps its exported snapshot alive until staged
`--init-db` finishes. The child receives the database fingerprint and snapshot
only in its process environment, imports that live snapshot, verifies the
PostgreSQL cluster and database identity, and performs all initialization writes
inside that same transaction. This keeps the writes on one PostgreSQL backend
even when `DATABASE_URL` points through a transaction-pooling proxy. A copied
data directory, promoted standby, restored disk snapshot, or other node cannot
import the exporter-owned snapshot even when its static fingerprint matches.
The guard is not persisted or printed. A guard rejection restores the previous
runtime environment but leaves Management stopped for explicit reconciliation
instead of reconnecting it to an unverified target.

A committed transaction emits exactly one redacted
`supacloud.control-plane-upgrade-safety.v1` receipt. It contains only the backup
identifier and directory, byte count, SHA-256 digest, migration candidate
counts, checkpoint state, and completion time. Admin validates the exact
receipt schema before deleting the transient
status and log records. A missing or malformed receipt leaves those records in
place and requires reconciliation. Restoring a control-plane backup is a
separate destructive operation and requires an explicit, independently reviewed
recovery decision; the upgrade command never restores one automatically.

Admin observes the remote transaction for up to 30 minutes. Reaching that
deadline stops only local observation; it does not stop, clean up, or mark the
remote transaction as failed. The CLI reports the unit, stage, status, log, and
upload-drop paths for reconciliation. Inspect that evidence before retrying and
do not retry blindly while the remote transaction may still be running.

When observation ends after 30 minutes, or to safely reconcile a retained
local-artifact upgrade transaction, use the read-only `ssh upgrade_status`
command:

```bash
npx @supacloud/admin ssh upgrade_status \
  --transaction_id 11111111-1111-4111-8111-111111111111
```

`ssh upgrade_status` is classified as a read-only command and is permitted in
read-only mode (`SUPACLOUD_READ_ONLY=true`). It requires a strict UUID v4
transaction ID before performing any SSH access. It never deletes status, log,
stage, or upload-drop records, and never mutates service state. The command emits
a strict JSON projection (`supacloud.admin.upgrade-status.v1`) containing the
normalized transaction ID, lifecycle state (`running`, `succeeded`, or
`failed`), raw bounded status, systemd active/load states, boolean
evidence-presence flags, and validated structured receipts:
- Nonterminal (`running`): no receipts or failure evidence are included.
- Succeeded: path-free projections of the validated control-plane preflight and
  transaction safety receipts.
- Failed: validated failure evidence with credentials and remote paths redacted.

The command fails closed for missing or inconsistent terminal evidence, stopped
nonterminal units, malformed or missing structured receipts, redacted or
truncated SSH output, or unknown status, without emitting raw logs, remote
filesystem paths, secrets, bearer material, env values, or customer data.

`--artifact_transport local` accepts only `--github_proxy direct` or `none` and
clears proxy environment variables on both hosts. The server-download path
remains available as `--artifact_transport remote`; it verifies and executes
the target Management release as the runner even for Management-only upgrades.

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

Targets predating the target-bound systemd-unit helper identity command are
rejected before mutation. A failed transaction still restores its exact frozen
prior Management/helper/Web identities; an intentional downgrade to a legacy
release requires a separately reviewed compatibility procedure.

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

## Verified logical backups

Use the official Admin CLI to list or create project-scoped verified logical
backups:

```bash
supacloud-admin platform list_logical_backups --ref abc123
supacloud-admin platform create_logical_backup --ref abc123
```

The create command reads the verified inventory before and after the one-shot
request. It reports success only when the Management response and exactly one
new inventory identity agree on the project, database, backup ID, kind,
timestamps, byte count, and SHA-256. The fixed JSON projection never includes
the server's receipt HMAC, archive path, subprocess output, or response-only
fields. Do not retry an `OUTCOME_UNKNOWN` create until the inventory has been
reconciled.

Logical restore is destructive and Management also requires the project to be
paused. Copy an exact identity from `list_logical_backups`, then bind all of its
recovery-critical fields:

```bash
supacloud-admin platform restore_logical_backup \
  --ref abc123 \
  --backup_id logical-full_abc123_0123456789abcdef0123456789abcdef \
  --expected_sha256 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --confirmation RESTORE_PROJECT:abc123:logical-full_abc123_0123456789abcdef0123456789abcdef:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

Both create and restore are classified as remote writes. They require an
explicit `SUPACLOUD_ENV`, honor `SUPACLOUD_READ_ONLY=true`, and in production
also require the global exact project confirmation
`--confirm-production abc123`. A timeout, transport loss, 5xx response, or
malformed success receipt exits non-zero without reflecting the remote body.
Logical mutation requests have a bounded 36-minute client deadline so the
Management request has time to return a terminal response before the client
gives up.
Credentials remain environment-only; logical backup commands accept no token,
password, or service-role flags.

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
