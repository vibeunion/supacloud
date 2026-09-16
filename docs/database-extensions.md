# Extension Management

The console and CLI use the same authorized project API:

```sh
supacloud database extension_catalog --ref PROJECT_REF
supacloud database enable_extension --ref PROJECT_REF --extension pgflow
supacloud database disable_extension --ref PROJECT_REF --extension pgflow
```

## Canonical pgflow Integration

There is one runtime: `packages/worker`, introduced by PR #1329. This change
does not introduce another worker package, installation registry or event store.
The Management API bundles the exact 0.16.0 shared-profile migrations, with
the same version IDs and checksums as `packages/worker/scripts/install.ts`.
It requires PGMQ and the project's real Realtime schema, not Supabase cloud
HTTP wakeups, Vault or tenant-local cron.

Fresh enable installs the canonical schema and restricted roles atomically.
Existing shared-profile installs are recognized only when project binding,
version and all migration checksums match. Dedicated-profile control upgrades
and unknown schemas require explicit review; no schema is deleted or silently
adopted.

Disable means pause, not uninstall: new pgflow runs and task claims stop.
Accepted handlers may finish, and runs, queue messages and outputs remain.
Resume uses the same data. This controls native pgflow workflows, not arbitrary
PGMQ queue consumers or side effects already performed by handlers.

Trusted definition publication, isolated worker credentials, process startup
and recovery scheduling still follow `docs/pgflow-installation.md`.
Enabling the core does not deploy business handlers. The console distinguishes
enabled-without-worker, running and paused states using database heartbeats.
The canonical independent recovery scheduler remains responsible for lease
recovery when Management is down.

## Native Extensions

Native extension removal uses RESTRICT, never CASCADE. Removal of known stateful
extensions is refused because even RESTRICT may delete extension-owned data.
`pg_durable` is not a generic tenant workflow toggle: its preload and configured
database must be provisioned by an administrator. Its removal remains blocked.

## Release Scope

The earlier experimental `packages/pgflow-worker` and broad runtime grants are
not part of this change. Neither is the unverified arm64 pg_durable source-build
change. Existing image defaults are preserved until an architecture-specific
image build and initialization acceptance has been completed.
