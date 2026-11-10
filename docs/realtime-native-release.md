# Native Realtime Release

SupaCloud can package the upstream Supabase Realtime OTP release without
installing Docker, Elixir, Mix, or Burrito on the target host.

The build is CI-only on Ubuntu 24.04 / amd64. The workflow pins upstream
Realtime `v2.150.0` to commit `af871a12160974525f2ff43613edf65a71f71742`
and builds it with `mix release`. `scripts/package_realtime_native_release.sh`
packages the release and checks its version before producing:

```text
supacloud-realtime-<version>-linux-amd64.tar.zst
SUPACLOUD-REALTIME-<version>-linux-amd64.json
SHA256SUMS
```

The target only receives the OTP release bundle. `supacloud-realtime` starts the
release and `supacloud-realtime-migrate` runs the release migration command.
The archive includes the Erlang runtime. The target still needs compatible
system libraries (libc, OpenSSL, ncurses, libstdc++) and CA certificates.
Systemd can supervise the release after installer integration; that integration
is not implemented here. The target does not need the Elixir toolchain or Burrito.

This package is deliberately separate from the Solo/Lite binary. Solo already
uses Bun's CI-built standalone executable. Both artifacts can be selected by a
future `supacloud install` profile, but they do not share a build tool:

| Profile | CI build | Runtime asset |
| --- | --- | --- |
| `solo` | `bun build --compile` | one `supacloud-lite-*` executable |
| `full-platform-single-node` | `mix release` | signed Realtime `tar.zst` bundle |

PR changes to the workflow or packaging scripts build the real upstream release,
extract the archive, and run its metadata migrations, health check and an
authenticated tenant-list request against an isolated PostgreSQL service.
The extracted process runs with the CI Elixir/OTP tools removed from `PATH`.
This checks bundled-runtime startup; it does not prove CDC/RLS compatibility.

Manual runs from `main` additionally generate keyless GitHub build-provenance
attestations and verify the archive, manifest and checksums. The downloadable
`supacloud-realtime-native-attested` CI artifact retains
`SUPACLOUD-RELEASE.attestation.jsonl` for offline verification. PR artifacts are
unsigned. To run the attested build after merging:

```bash
gh workflow run realtime-native-release.yml --ref main
```

The optional `upload_release_tag` input only accepts an existing
`realtime-native-v2.150.0` release. Uploads never overwrite existing assets.
The normal installer still trusts `release-please.yml`; it does not yet consume
this separate workflow or its new archive format. No live host or tenant data
is changed by the workflow.

The native Realtime bundle is not the default runtime until it passes the same
tenant registration, JWT, Phoenix WebSocket, Broadcast, Presence, PostgreSQL
Changes, RLS, migration, restart, and rollback acceptance as the current
container-backed runtime. Building or signing this artifact is not deployment
evidence.

The package script has a focused local fixture test:

```bash
bash scripts/package_realtime_native_release.test.sh
```
