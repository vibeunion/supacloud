# Native Realtime Release

SupaCloud can package the upstream Supabase Realtime OTP release without
installing Docker, Elixir, Mix, or Burrito on the target host.

The build is CI-only. A pinned upstream Realtime tag is built with `mix release`
inside the CI runner, then `scripts/package_realtime_native_release.sh` produces
a signed release bundle:

```text
supacloud-realtime-<version>-linux-amd64.tar.zst
SUPACLOUD-REALTIME-<version>-linux-amd64.json
SHA256SUMS
```

The target only receives the OTP release bundle. `supacloud-realtime` starts the
release and `supacloud-realtime-migrate` runs the release migration command.
Systemd remains the process supervisor. The target does not need the Elixir
toolchain or Burrito.

This package is deliberately separate from the Solo/Lite binary. Solo already
uses Bun's CI-built standalone executable. Both artifacts can be selected by a
future `supacloud install` profile, but they do not share a build tool:

| Profile | CI build | Runtime asset |
| --- | --- | --- |
| `solo` | `bun build --compile` | one `supacloud-lite-*` executable |
| `full-platform-single-node` | `mix release` | signed Realtime `tar.zst` bundle |

The native Realtime bundle is not the default runtime until it passes the same
tenant registration, JWT, Phoenix WebSocket, Broadcast, Presence, PostgreSQL
Changes, RLS, migration, restart, and rollback acceptance as the current
container-backed runtime. Building or signing this artifact is not deployment
evidence.

The package script has a focused local fixture test:

```bash
bash scripts/package_realtime_native_release.test.sh
```
