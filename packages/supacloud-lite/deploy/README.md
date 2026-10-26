# SupaCloud Lite production deployment

This directory contains a minimal single-project deployment contract. It is not
a multi-tenant control plane. Run one Lite process per state directory and put
TLS plus a reverse proxy in front of it.

## Layout

```text
/opt/supacloud-lite/project       reviewed migrations, seed and functions (read-only at runtime)
/var/lib/supacloud-lite           database, storage and snapshots (persistent)
/etc/supacloud-lite/env           secrets and runtime configuration (root:root 0600)
/usr/local/bin/supacloud-lite     installed CLI / standalone binary
```

The systemd unit sets `SUPACLOUD_LITE_STATE_DIR=/var/lib/supacloud-lite`, so the
project checkout does not contain mutable data.

## Install

1. Install the pinned Lite release and verify its version.
2. Create a service account and directories:

```sh
sudo useradd --system --home /var/lib/supacloud-lite --shell /usr/sbin/nologin supacloud-lite
sudo install -d -o supacloud-lite -g supacloud-lite -m 0750 /var/lib/supacloud-lite
sudo install -d -o root -g root -m 0755 /opt/supacloud-lite/project /etc/supacloud-lite
```

3. Put the reviewed project files under `/opt/supacloud-lite/project`.
4. Create `/etc/supacloud-lite/env` from the project's deployment secret store.
   Keep it `root:root` and `0600`. Supported values include `S3_*` credentials,
   `SUPACLOUD_LITE_S3_PREFIX`, `SUPACLOUD_LITE_STORAGE_BACKEND=s3`, and the
   trusted external identity module setting.
5. Run migrations and create the first local account **before** starting the
   service:

```sh
sudo -u supacloud-lite env SUPACLOUD_LITE_STATE_DIR=/var/lib/supacloud-lite \
  supacloud-lite migrate --project-dir /opt/supacloud-lite/project
sudo -u supacloud-lite env SUPACLOUD_LITE_STATE_DIR=/var/lib/supacloud-lite \
  supacloud-lite auth create-user --project-dir /opt/supacloud-lite/project \
  --email operator@example.com --password-stdin --email-confirm < /secure/password.txt
```

6. Install the unit and reload systemd:

```sh
sudo install -m 0644 deploy/systemd/supacloud-lite.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now supacloud-lite
curl -fsS http://127.0.0.1:54321/health
```

7. Install the Caddy site from `deploy/caddy/Caddyfile`, replace the hostname,
   and verify HTTPS plus an authenticated API request.

## External SupAuth

If the browser application and identity service are on different origins and
the identity service does not allow the application origin via CORS, use the
restricted same-origin proxy documented in the package README:

```sh
supacloud-lite start \
  --external-auth-proxy-issuer https://auth.example.com/auth/v1 \
  --external-auth-proxy-redirect-origin https://app.example.com
```

The proxy handles only OAuth token, userinfo and logout. Authorization remains a
top-level navigation. Membership and application permissions stay in the
application-owned data and RLS model; Lite does not grant them from token claims.

## Backup, upgrade and restore

Lite snapshots require the process to be stopped. Use a maintenance window:

```sh
sudo systemctl stop supacloud-lite
sudo -u supacloud-lite env SUPACLOUD_LITE_STATE_DIR=/var/lib/supacloud-lite \
  supacloud-lite snapshot create \
  --project-dir /opt/supacloud-lite/project \
  -o /var/lib/supacloud-lite/backups/pre-upgrade.tar.gz
sudo systemctl start supacloud-lite
```

For an upgrade, stop the service, install the pinned candidate, run
`supacloud-lite upgrade`, start the service, and verify `/health` and a real
authenticated read. If the upgrade fails, restore the pre-upgrade snapshot with
`snapshot restore --force` and restart the previous binary.

When using S3, snapshots contain database metadata and secrets but **not remote
objects**. Back up the bucket/prefix separately and restore it before starting
the service. `db reset` is intentionally rejected in S3 mode.

## Production checks

Before exposing the service:

- keep the process bound to loopback and terminate TLS at the proxy;
- use `--runtime-mode strict` for functions;
- set an explicit snapshot retention period and test a restore drill;
- use S3/MinIO or a durable mounted volume for storage, not an ephemeral disk;
- use native PostgreSQL when the project needs extensions such as `pg_graphql`;
- keep one process per state directory; Lite is not a multi-writer cluster;
- verify unauthenticated API calls fail closed and authenticated reads succeed.

`supacloud-lite doctor --json` reports the selected engine, extension inventory,
identity mode and replication readiness. It is a capability report, not a
production security certification.
