# Platform installation and operations

[English](platform-operations.md) | [简体中文](platform-operations.zh-CN.md) · [Project overview](../README.md)

This guide collects the full-platform entry points previously embedded in the root README. For Lite's single-process state, upgrades and snapshots, use the [Lite guide](../packages/supacloud-lite/README.md).

## Before installation

Review supported host/component prerequisites in [setup.sh](../setup.sh) and [install.sh](../install.sh). Size CPU, memory and disk for project count and workload; the minimum installation footprint is not a production capacity guarantee. Prepare DNS, TLS reachability, trusted operator access and a recovery plan.

Tracked [config.env](../config.env) contains defaults. Installation inputs persist in `/etc/supabase/install.env`; Management API runtime settings live separately in `/etc/supabase/management-api.env`. Do not overwrite one with the other. See the [deployment guide](deploy-guide.md) for configuration and release trust boundaries.

## Verified installation

Read the installer before executing it as root. Fetch the bootstrap directly from the official repository:

```bash
curl -fsSL https://raw.githubusercontent.com/vibeunion/supacloud/main/setup.sh | sudo bash
```

An operator may explicitly configure a trusted fallback for subsequent GitHub Release/API downloads:

```bash
curl -fsSL https://raw.githubusercontent.com/vibeunion/supacloud/main/setup.sh \
  | sudo env SUPACLOUD_GITHUB_PROXY=https://your-trusted-proxy.example bash
```

Do not wrap the root bootstrap URL in a third-party proxy. Network release artifacts require SHA256 and build-provenance verification; a proxy does not replace verification. Offline verification uses the reviewed, pinned Sigstore trusted root rather than live TUF egress. Do not disable verification for a normal installation.

### Source/development installation

A source checkout contains no release artifacts. Build Management API, Edge Runtime, pgredis-runtime, custom Caddy and Web Console before opting into local artifact mode. Follow the package scripts and dependency installation order in [Management API CI](../.github/workflows/management-api.yml); building only Management API is insufficient. The [Caddy build script](../scripts/build_supacloud_caddy.sh) records toolchain pins.

Only after all required local outputs exist and pass their checks, run from the repository root:

```bash
sudo env SUPACLOUD_SETUP_ARTIFACT_MODE=local \
  bash install.sh --ip 203.0.113.10 --domain api.example.com --s3 juicefs
```

The IP and domain are placeholders. Production hosts should normally use verified releases, not a partial checkout or an unverified local build. This documentation change does not establish a new source-build acceptance result.

## CLI connections

The project CLI uses `SUPABASE_URL` or `SUPACLOUD_API_URL`, and `SUPABASE_SERVICE_ROLE_KEY` or `SUPACLOUD_API_TOKEN`. It can auto-link from the current workspace `.env`. Keep credentials out of source control and browser bundles. Generated application environment wrappers have a separate selection contract; see the [starter guide](application-starter.md).

```bash
supacloud-cli status
supacloud-cli project get
supacloud-cli project logs --log_type database
```

The npm entry defaults to Node.js. To explicitly use Bun, including from Windows terminals:

```bash
bunx --bun --package @supacloud/cli supacloud-cli status
```

AI agents can inspect and install the CLI's migration-first Skill:

```bash
supacloud-cli ai install_skill --dry_run
supacloud-cli ai install_skill
```

Configure the operator connection in the [CLI guide](cli-guide.md), then use Admin for host/platform operations:

```bash
npx @supacloud/admin status
npx @supacloud/admin ssh ping
```

`supacloud-cli` is project-scoped. Installation, upgrades, SSH diagnostics and platform project lifecycle belong to `supacloud-admin`. `supacloudctl` is an optional dispatcher; `supacloud` names the compiled server binary, not a project-CLI alias.

## Production upgrades

Choose exact **published** Management and Edge Runtime versions after reviewing [component upgrade notes](platform-component-upgrade-notes.md), migrations and recovery requirements. Repository package versions alone are not publication evidence. These shell variables are operator-selected inputs, not new platform configuration keys:

```bash
: "${MANAGEMENT_VERSION:?Choose an exact published Management version}"
: "${EDGE_RUNTIME_VERSION:?Choose an exact published Edge Runtime version}"
npx @supacloud/admin ssh upgrade \
  --version "$MANAGEMENT_VERSION" \
  --edge_runtime_version "$EDGE_RUNTIME_VERSION" \
  --artifact_transport local \
  --github_proxy direct
```

Local transport downloads exact releases on the Admin host, verifies the manifest, SHA256, size, source commit and architecture, then uploads an atomic SFTP staging tree. After establishing root ownership, the server re-verifies offline and runs the **target** Management binary for the transaction. Local transport accepts `direct` or `none`; the server needs neither GitHub/TUF egress nor a permanent verifier. A compatible installed `gh` is reused; otherwise a pinned temporary verifier stays inside the removable staging tree.

The coordinated Management/Web Console/Edge Runtime transaction requires persisted `EDGE_RUNTIME_MODE=external`. Embedded mode is rejected before coordinated activation changes artifacts or services. The Edge executable path, port, mode and enabled state are preserved. **Caddy and GoTrue are outside this transaction and are not replaced.**

Remote transport also uses the target Management binary. Local, remote and direct-server upgrades share a nonblocking host-wide lock. To intentionally upgrade only Management and Web Console, use remote transport and omit `--edge_runtime_version`:

```bash
: "${MANAGEMENT_VERSION:?Choose an exact published Management version}"
npx @supacloud/admin ssh upgrade \
  --version "$MANAGEMENT_VERSION" \
  --artifact_transport remote
```

### Observation and rollback

The server transaction runs in a uniquely named transient systemd unit and publishes protected atomic status. Admin observes it through short SSH calls for up to 30 minutes. **An observation timeout does not stop the transaction and is not proof of failure.** Inspect the reported unit, stage, status, log and upload-drop paths before retrying. Do not remove staging or start a conflicting upgrade while activation may still be running.

Production servers do not need to `git pull` application source. Do not trust an old installed binary to implement a new activation contract. An artifact rollback does not undo database migrations or business side effects; follow the component recovery procedure and verify the resulting state.

## Delivery and runtime boundaries

Frontend releases use immutable archive hashes and activation compare-and-swap values. Function mutations require the observed active version; positive versions permit immutable source backup, while `0` is only the legacy active-version token. Reconcile stale mutations instead of blindly replaying them. Full commands, receipts and rollback constraints remain in the [CLI](cli-guide.md), [frontend](frontend-hosting.md) and [Edge Runtime](edge-runtime-guide.md) guides.

Embedded Edge Runtime is managed by `supacloud.service`; external mode uses `supacloud-edge-runtime.service`. Do not run both at once. Public `/functions/v1/*` and `/realtime/v1/websocket` traffic enters Management API, not worker/Realtime internals directly. See [background functions](background-functions.md).

Caddy routing is published as validated JSON through its Admin API, not by hand-editing a production Caddyfile. See [gateway ownership and recovery](gateway-customization.md). [pgredis-runtime](pgredis-runtime.md) is a private data plane: browsers do not call its internal port and workers do not receive PostgreSQL credentials. PGMQ remains the platform queue.

## Storage, recovery and observability

[Project-scoped S3](project-scoped-s3.md) is separate from switching the instance default. Approve origins, use least-privilege credentials and verify the actual provider. A configured backend failure never triggers fallback. Existing platform objects require adoption during a quiesced window; do not remove bindings or deploy pre-feature code to repair a connection.

[Backup operations](pigsty-backup-operations.md) cover inventory verification, PITR planning and recovery drills. The [AI Operations MCP](mcp-ai-operations.md) is plan-only for writes: a restoration plan is not an executed restore. [Observability](observability.en.md) covers VictoriaLogs, the in-process collector, metrics, tracing and Grafana. Tests, plans and green endpoints do not replace workload-specific restore drills.

The [documentation index](README.md) retains detailed APIs, OAuth/OIDC, migrations, tasks, scaling and troubleshooting. Use current topic guides rather than copying the old root README's example release versions or historical feature counts.
