# Dedicated Linux Delivery Acceptance

This is a real systemd/journald/Caddy integration check, not the full business
acceptance or a production deployment. Use only a disposable Linux machine:
the runner requires root, the `supacloud-delivery-linux` tenant, and exclusive
ports 80, 443 and 2019. It never installs the full platform.

## Build

Run sequentially from the repository root with Bun 1.4.2:

```sh
npm exec --yes --package=bun@1.4.2 -- bun run --cwd packages/compiler build
npm exec --yes --package=bun@1.4.2 -- bun scripts/build-linux-delivery-acceptance.ts
```

The second command prints a temporary directory containing a detached HTTP and
Worker archive, bundled runner, broker, systemd template and build metadata.
The compiler source fixture and node_modules links are removed. The metadata
records every compiler dist file digest and the runner/broker/template/manifest
digests. The runner checks the transferred file digests before any effects.
Do not run a compiler build concurrently with consumers of its dist directory.

Transfer only that generated directory. For isolated OrbStack machines, stdin
tar transfer works without shared host files. On macOS disable Apple metadata,
otherwise `._*` files correctly fail immutable archive inventory validation:

```sh
env COPYFILE_DISABLE=1 tar --no-xattrs -C "$(dirname "$BUNDLE")" -cf - "$(basename "$BUNDLE")" \
  | orb -m "$MACHINE" -u root tar -C /tmp -xf -
```

`BUNDLE` is the printed local directory and `MACHINE` is an owned disposable
machine. The destination below is `/tmp/<bundle-directory-name>`.

## Linux Prerequisites

Inside the dedicated machine, install a Linux Bun 1.4.2 binary at
`/opt/supacloud/bun/1.4.2/bun` and Caddy at `/usr/local/bin/supacloud-caddy`.
The September 26 run used binaries from the already cached arm64
`oven/bun:1.4.2` and `caddy:2.11.4-alpine` images, not a platform image.

With `BUNDLE` set to the transferred Linux directory:

```sh
useradd --system --user-group --no-create-home supacloud-delivery-linux
install -D -m 0755 "$BUNDLE/systemd-unit" /usr/local/libexec/supacloud/systemd-unit
install -D -m 0644 "$BUNDLE/supacloud-systemd-unit@.service" /etc/systemd/system/supacloud-systemd-unit@.service
systemctl daemon-reload
env SUPACLOUD_LINUX_ACCEPTANCE=1 SUPACLOUD_CADDY_TLS_ISSUER=internal \
  /opt/supacloud/bun/1.4.2/bun --no-env-file "$BUNDLE/linux-delivery-acceptance.js"
```

Create the tenant once, not before every rerun. No credentials are needed; the
Management API config import's development-secret warnings do not mean a
Management API server or secret store has been started.

## Evidence And Cleanup

The runner verifies:

- Verified archive intake and immutable runtime file preparation.
- Default managed-unit broker, actual systemd start/stop, exact tenant UID/GID.
- Default loopback readiness and Worker journal identity bound to PID/invocation.
- Actual Caddy validation/load, durable/live route readback and proxied HTTP 200.
- Provider object reconstruction and readback; this is not a Caddy process restart.
- Actual target restart with changed invocation identity, and HTTP not-ready state.
- Stopped process observations and unit removal during cleanup.

It rejects occupied ports before Caddy writes, verifies the owned child's
bootstrap config, and treats unexpected child exit as failure. SIGINT/SIGTERM
terminate only the owned Caddy child to close even stalled gateway requests,
then cancel between effects. An in-flight systemctl operation finishes before
cleanup, avoiding concurrent start/stop. SIGKILL of the runner or a host crash
cannot run this cleanup. Signals do not impose a new timeout on the broker.

Each run retains `receipt.json`, Caddy logs/config and release files under
`/var/lib/supacloud-delivery-acceptance/run-*`. Runtime artifacts are retained
under `/var/supacloud/application-runtime/delivery-linux/<activation-id>` as
evidence; units/processes are removed. Dispose of the owned machine after
collecting evidence rather than deleting arbitrary host paths.

Not covered: real business persistence/auth/transactions/uploads, activation
mutation journal composition, custom Caddy rate-limit modules, HTTPS certificate
issuance, machine reboot, release upgrade/rollback and independent data recovery.

## 2026-09-27 Run

The previously generated detached bundle was transferred to the dedicated
acceptance VM after removing macOS `._*` metadata files. With the existing
Management API and Caddy units temporarily stopped, the runner passed using
Linux Bun 1.4.2:

- HTTP and Worker targets reached readiness under systemd with exact
  non-root tenant UID/GID checks.
- Caddy loaded the route and proxied `delivery.example.test` to HTTP 200.
- A real stop/start produced new invocation IDs and PIDs.
- Forcing the HTTP target into its not-ready state produced
  `HTTP_NOT_READY` while the Worker remained ready.
- Both targets stopped cleanly and managed units were removed.

Receipt from the current-source rebuild:
`/var/lib/supacloud-delivery-acceptance/run-Ybues5/receipt.json` on the VM.
The receipt status was `PASS`; its scope remained
`real-systemd-journald-caddy` and explicitly excluded the application
activation journal and business database. Management API and Caddy were
restarted afterward. All four services, including the untouched GoTrue and
PostgREST units, were confirmed `active`.
