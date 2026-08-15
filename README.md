# SupaCloud

[English](README.md) | [简体中文](README.zh-CN.md) | [Español](README.es-ES.md)

---

The English README is canonical. See the [translation policy](docs/translation-policy.md) for synchronization expectations.

## English

**SupaCloud** is a next-generation, ultra-lightweight multi-tenant PaaS for self-hosting Supabase. Built on **Pigsty**, it enables you to run multiple isolated Supabase projects efficiently on a single server.

### Key Features

- **Multi-Tenant Architecture**: Run multiple isolated Supabase projects with shared infrastructure
- **Management API**: Full REST API (60+ endpoints) for complete project lifecycle management
- **Web Console**: Modern SvelteKit management dashboard with authentication
- **Official Supabase CLI Database Workflows**: The compatibility harness exercises direct `--db-url` flows including `db push`, `migration list`, `db pull`, and `gen types`
- **CLI Tools**: `supacloud-cli` for project users, `supacloud-admin` for server operators, and optional `supacloudctl` as the local unified dispatcher
- **SupaCloud Pages**: Frontend static site hosting with GitHub webhook auto-deploy
- **Pigsty Powered**: Enterprise-grade PostgreSQL with built-in monitoring (Grafana)
- **One-Click Installation**: Fully automated setup via `install.sh`
- **JuiceFS Storage**: Powered by PostgreSQL Large Objects (LO) for ultra-thin metadata
- **Caddy Gateway**: Automatic HTTPS, Admin API-driven route publishing, programmable rate limiting, security headers, and CORS
- **Auto-scaling Engine**: Rule-based vertical and horizontal scaling based on real-time metrics
- **Bun Edge Runtime**: Bun.js + Elysia Worker Pool for Edge Functions, with built-in Deno compatibility shim for legacy user code
- **SSE Real-time Logs**: Server-Sent Events streaming for live log tailing via `journalctl --follow`
- **Native Queue Worker**: Pure Bun.js PostgreSQL LISTEN/NOTIFY based asynchronous worker for AI inference and MQTT events
- **WebSocket Task Notifications**: Real-time task progress push via native Bun WebSocket
- **DB Graceful Degradation**: Exponential backoff retry + 503 Service Unavailable on transient DB failures
- **Hardened Control Plane**: Authenticated function management reads, one-time signed uploads, defensive pagination, and safe storage metadata parsing
- **Edge Function Preheating**: Zero cold-start via worker module pre-import on deploy
- **Project OAuth/OIDC Provider**: Per-project OAuth 2.1 / OIDC migration with ES256 signing keys, discovery, JWKS, authorize/token/userinfo endpoints, and OAuth client CRUD
- **China OAuth**: Built-in WeChat, Alipay, DingTalk login integration
- **CI/CD Integration**: GitHub webhook for automated deployments
- **Comprehensive Tests**: 400+ unit, integration, and structural regression tests

### SupaCloud Lite

**SupaCloud Lite** is the Bun-native, single-project edition of SupaCloud. It runs PostgreSQL-compatible workloads in-process with PGlite and exposes the Supabase protocols used by `@supabase/supabase-js`: REST, Auth, Storage, Realtime, and Edge Functions. It is intended for local development, small single-project deployments, and applications that want a Docker-free Supabase-compatible backend.

Lite Auth is built into the same Bun process; it does not install or launch a GoTrue sidecar. It is enabled by default and can be disabled with `[auth] enabled = false` in `supabase/config.toml`, which turns off `/auth/v1/*`. Use the full platform when an independent GoTrue runtime or full GoTrue compatibility is required.

Use the full SupaCloud platform when you need multi-project tenancy, a management API or web console, shared Pigsty infrastructure, platform operations, and hosted frontend lifecycle management. Lite deliberately does not provide a multi-project control plane or Supabase Studio; each Lite process owns one project and its own state directory.

| Need | Choose |
| --- | --- |
| Local-first or single-project runtime without Docker | SupaCloud Lite |
| Multi-tenant platform, operator controls, or production infrastructure management | SupaCloud |

Lite requires Bun 1.3+ and keeps its default database, storage, and generated secrets under `.supacloud-lite/` in the project directory. Start it with the existing Supabase CLI project layout:

```bash
bun add @supacloud/lite
bunx supacloud-lite start
bunx supacloud-lite keys
```

Then use the printed anonymous key with the standard client:

```ts
import { createClient } from '@supabase/supabase-js'

const supabase = createClient('http://127.0.0.1:54321', process.env.SUPACLOUD_LITE_ANON_KEY!)
```

See [SupaCloud Lite documentation](./packages/supacloud-lite/README.md) for CLI commands, storage/S3 configuration, compatibility limits, migration guidance, and deployment boundaries.

For persistent Lite deployments, update the pinned `@supacloud/lite` dependency and run `supacloud-lite upgrade`. The command creates a portable database/storage/secrets snapshot before applying pending migrations. `snapshot create` and fail-closed `snapshot restore` are also available for host migration and rollback preparation.

### SupaCloud vs Supabase

SupaCloud is best understood as a **self-hosted multi-tenant control plane for Supabase-style projects**, not as a clone of Supabase Cloud.

Short version:

- **SupaCloud**: best when you want to run many isolated projects on your own servers with a built-in operator API, web console, project lifecycle management, task queue surface, and frontend hosting.
- **Supabase Cloud**: best when you want a fully managed platform, hosted backups/PITR, hosted logs explorer, and hosted branching.
- **Supabase Self-Hosted**: best when you want the official upstream stack on your own infra and are comfortable operating Docker/services directly.

Detailed feature comparison:

- [docs/supacloud-vs-supabase.md](./docs/supacloud-vs-supabase.md)

### Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                  Management API (:9090)                      │
│            Bun + Elysia + TypeScript + Auto-scaling          │
├─────────────────────────────────────────────────────────────┤
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ JwtService │  │ DbService  │  │ StorageSvc │            │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘            │
│        ▼               ▼               ▼                    │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ GatewaySvc │  │ ScalingSvc │  │ BackupSvc  │            │
│  └────────────┘  └────────────┘  └────────────┘            │
│        ▼               ▼               ▼                    │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ RouterSvc  │  │ FrontendSv │  │ DeploySvc  │            │
│  └────────────┘  └────────────┘  └────────────┘            │
├─────────────────────────────────────────────────────────────┤
│                   Shared Infrastructure                      │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ PostgreSQL │  │   Caddy    │  │  JuiceFS   │            │
│  │  (Pigsty)  │  │  Gateway   │  │  (PG-LO)   │            │
│  └────────────┘  └────────────┘  └────────────┘            │
│                  ┌────────────┐                             │
│                  │  Grafana   │                             │
│                  │ (Monitor)  │                             │
│                  └────────────┘                             │
└─────────────────────────────────────────────────────────────┘
```

### Quick Start

#### Requirements

| Item | Minimum | Recommended |
|------|---------|-------------|
| CPU | 2 cores | 4+ cores |
| RAM | 2GB | 4GB+ |
| Disk | 40GB | 100GB+ SSD |
| OS | CentOS 9, Ubuntu 22/24, Debian 12 | CentOS 9 |

#### Human Entrypoints

**Project user CLI**

```bash
npm install -g @supacloud/cli

supacloud-cli status
supacloud-cli project get
supacloud-cli project logs --log_type database
supacloud-cli frontend list --ref <project-ref>
```

`supacloud-cli` defaults to project context and auto-links from the current workspace `.env` when available.
There is no project-CLI compatibility alias named `supacloud`: that name is reserved for the compiled server binary at `/usr/local/bin/supacloud`. Use `supacloudctl` only for the optional local unified dispatcher.

- `SUPABASE_URL` or `SUPACLOUD_API_URL`
- `SUPABASE_SERVICE_ROLE_KEY` or `SUPACLOUD_API_TOKEN`

AI agents should install the migration-first Skill shipped with the CLI:

```bash
supacloud-cli ai install_skill --dry_run
supacloud-cli ai install_skill
```

**Server admin CLI**

```bash
npx @supacloud/admin status
npx @supacloud/admin ssh ping
npx @supacloud/admin ssh install --public_domain api.example.com --studio_domain studio.example.com
npx @supacloud/admin project create --name my-app
```

Use `supacloud-admin` for installation, upgrades, tenant runtime operations, and platform-wide project lifecycle control.

#### Server Installation

**One-Click Installation (Recommended)**

```bash
curl -fsSL https://raw.githubusercontent.com/zuohuadong/supacloud/main/setup.sh | sudo bash
```

The root bootstrap itself is always fetched from the official repository. Release/API downloads try GitHub directly first and use `SUPACLOUD_GITHUB_PROXY` only as an explicit fallback:

```bash
curl -fsSL https://raw.githubusercontent.com/zuohuadong/supacloud/main/setup.sh \
  | sudo env SUPACLOUD_GITHUB_PROXY=https://your-trusted-proxy.example bash
```

**Source/Development Installation (local artifacts only)**

Production hosts should use the verified one-click `setup.sh` flow above. A source checkout has no Release artifacts, so build every required component first and opt into local artifact mode explicitly:

```bash
# 1. Clone repository
git clone https://github.com/zuohuadong/supacloud.git
cd supacloud

# 2. Build Management API, Edge Runtime, pgredis-runtime, Caddy, and Web Console artifacts
bun --cwd packages/management-api install
bun --cwd packages/management-api run build:linux
bun --cwd packages/edge-runtime install
bun --cwd packages/edge-runtime run build:linux
bun --cwd packages/pgredis-runtime install
bun --cwd packages/pgredis-runtime run build:linux
bun --cwd packages/web-console install --frozen-lockfile
bun --cwd packages/web-console run build
mkdir -p .local/bin dist
GOBIN="$PWD/.local/bin" go install github.com/caddyserver/xcaddy/cmd/xcaddy@v0.4.5
PATH="$PWD/.local/bin:$PATH" OUT_DIR="$PWD/dist" bash scripts/build_supacloud_caddy.sh

# 3. Configure and install from the validated local build outputs
sudo env SUPACLOUD_SETUP_ARTIFACT_MODE=local \
  bash install.sh --ip 1.2.3.4 --domain api.example.com --s3 juicefs

# 4. Enable CLI
source /etc/profile.d/supacloud.sh
```

**Production Upgrades**

Use the Admin CLI for a verified multi-component production upgrade. Pin exact
Management and Edge Runtime versions so the command can verify and activate
Management, Web Console, and an external Edge Runtime as one rollback-capable
transaction:

```bash
npx @supacloud/admin ssh upgrade \
  --version 0.50.31 \
  --edge_runtime_version 0.16.8 \
  --artifact_transport local \
  --github_proxy direct
```

`--artifact_transport local` downloads exact releases directly on the Admin
host, verifies the signed manifest, SHA256 checksums, sizes, source commit, and
architecture, then uploads an atomic SFTP staging tree. After root ownership is
established, the server repeats offline verification and uses the uploaded
target Management binary for the Management/Edge/Web transaction. The server
does not need GitHub or Sigstore TUF egress, a third-party proxy, or a permanent
verifier. SupaCloud pins the TUF-reviewed Sigstore Public Good trusted root in
the reviewed release code and passes it explicitly to every offline
verification; verification therefore remains strict when TUF DNS or network
access is unavailable. Local transport accepts only `direct` or `none`. A
compatible installed `gh` is reused; only a server without the required strict
attestation flags receives a pinned temporary verifier inside the removable
staging tree.

The transaction runs in a uniquely named transient systemd unit and publishes a
protected atomic status record. Admin polls that record through short SSH calls;
it does not blindly stop a transaction that may have entered activation. The
server-download path remains available as `--artifact_transport remote`; it
also verifies and executes the exact target Management binary as the upgrade
runner instead of delegating target-specific work to the installed prior version.
Local, remote, and direct server upgrades share one nonblocking host-wide lock.

Admin observes the remote transaction for up to 30 minutes. Reaching that
deadline stops only local observation; it does not stop, clean up, or mark the
remote transaction as failed. The CLI reports the unit, stage, status, log, and
upload-drop paths for reconciliation. Inspect that evidence before retrying and
do not retry blindly while the remote transaction may still be running.

This transaction requires persisted `EDGE_RUNTIME_MODE=external`; embedded
mode is rejected before release artifacts or services are changed. It preserves
the Edge Runtime systemd executable path, port, mode, and enabled state, and
verifies each released component against its own SHA256 checksum and GitHub
attestation. Caddy and GoTrue are outside this transaction and are not replaced.

With `--artifact_transport remote` (the default), omit
`--edge_runtime_version` only when intentionally upgrading Management and Web
Console without changing Edge Runtime. Local transport requires exact
Management and Edge Runtime versions.

For a Management/Web Console-only upgrade, use Admin remote transport and omit
`--edge_runtime_version`. Production servers do not need to `git pull`
application source, and an installed prior Management binary is never trusted
to implement a newer release's helper or Web activation contract.

```bash
npx @supacloud/admin ssh upgrade \
  --version 0.60.1 \
  --artifact_transport remote \
  --github_proxy direct
```

Install and upgrade downloads are direct-first. Configure a trusted proxy only when an explicit fallback is required:

```bash
npx @supacloud/admin ssh upgrade \
  --version 0.60.1 \
  --artifact_transport remote \
  --github_proxy https://your-trusted-proxy.example
```

Release artifacts require same-release SHA256 verification and GitHub build provenance attestation. `SUPACLOUD_ALLOW_UNVERIFIED_RELEASE=true` is an emergency break-glass mode that retains SHA256 verification but must not be a normal installation setting.

Published release assets:

- `supacloud-linux-amd64` and `supacloud-linux-arm64` are the production install/upgrade binaries.
- `supacloud-macos-amd64` and `supacloud-macos-arm64` are published for local development and diagnostics.

**Docker Compose Self-Host (PostgreSQL 18)**

```bash
cd docker/self-host
python3 init-env.py --public-url https://api.example.com --studio-url https://studio.example.com --output .env
docker compose up -d --build
```

The compose stack is isolated under [`docker/self-host`](/Volumes/Data/workspace/supacloud/docker/self-host) and ships a PostgreSQL 18 image with common extensions preinstalled.

For the Docker-specific Pigsty 4.4/Supabase compatibility check and backup-first upgrade path, see [`docs/upgrade-postgres-docker-4.4.md`](./docs/upgrade-postgres-docker-4.4.md). Do not run the native Pigsty upgrade script against a Docker data volume.

For TrueNAS SCALE `Custom App` deployment of the published PostgreSQL image, see [`docker/self-host/TRUENAS.md`](./docker/self-host/TRUENAS.md).

**Available CLI Options:**
| Option | Description | Example |
|--------|-------------|---------|
| `--ip` | Server Internal IP | `--ip 10.0.0.5` |
| `--domain` | API/Public Domain | `--domain supa.com` |
| `--studio` | Studio Dashboard Domain| `--studio studio.com`|
| `--s3` | Storage Type | `juicefs`, `minio`, or `external` |
| `--password`| Master Password | `--password mysecret` |

### Management

#### User CLI: `supacloud-cli`

The `supacloud-cli` command is project-scoped by default and is intended for deploy/build/log/database workflows around a single project:

```bash
supacloud-cli status
supacloud-cli project get
supacloud-cli project logs --log_type database
supacloud-cli project tasks
supacloud-cli database query --sql "select now()"
supacloud-cli database query --ref <ref> --file ./queries/vector-search.sql
supacloud-cli database push_migrations --ref <ref> --dir supabase/migrations --dry_run
supacloud-cli auth list_providers --ref <ref>
supacloud-cli frontend list --ref <ref>
supacloud-cli edge_functions list --ref <ref>
supacloud-cli edge_functions source --ref <ref> --slug hello --version 1 --output ./hello-v1.ts
supacloud-cli edge_functions deploy --ref <ref> --slug hello --path ./supabase/functions/hello --expected-active-version absent
supacloud-cli edge_functions deploy --ref <ref> --slug hello --prebundled-path ./dist/hello.js --expected-sha256 <sha256> --expected-active-version 1
supacloud-cli edge_functions activate --ref <ref> --slug hello --version 2 --expected-active-version 3
supacloud-cli storage list_buckets --ref <ref>
```

Function deploy and activation commands require the active version observed via
`edge_functions list`; `absent` is valid only for a new slug. Stale mutations
return HTTP 409 and successful mutations emit a
`supacloud.cli.release-control.v1` receipt. When the observed version is
positive, pass it to `edge_functions source --version <N>` for an immutable,
ABA-safe source backup.
Use `deploy --prebundled-path` with the required lowercase
`--expected-sha256` when a release pipeline must upload an already-built runtime
artifact without local or server rebundling. The mode rejects caller-hash,
file-stability, UTF-8, runtime-policy, and normalization mismatches before
activation.
Version `0` is reserved for a listed legacy Function's active-version CAS token.
It is valid only as `--expected-active-version 0`; immutable source reads and
activation targets still require a positive version.

For complex SQL, pgvector queries, and single-request transaction blocks, prefer `--file` instead of shell-escaped inline SQL.

```sql
BEGIN;
INSERT INTO audit_events(message) VALUES ('started');
INSERT INTO audit_events(message) VALUES ('finished');
COMMIT;
```

SupaCloud supports transaction blocks inside one SQL request and wraps migrations in a transaction. It does not expose long-lived HTTP transaction sessions such as `/transaction/begin` and `/transaction/commit`; application-side long transactions should use the direct Postgres DSN with `pg`, `postgres.js`, or equivalent drivers.

pgvector example:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content text NOT NULL,
  embedding vector(1536)
);

CREATE INDEX documents_embedding_hnsw_idx
ON documents
USING hnsw (embedding vector_cosine_ops);

SELECT id, content
FROM documents
ORDER BY embedding <=> '[0.1,0.2,0.3]'::vector
LIMIT 5;
```

`supacloud-cli` intentionally does **not** own platform installation, upgrades, SSH diagnostics, tenant runtime management, or destructive project lifecycle commands.

#### Admin CLI: `supacloud-admin`

The `supacloud-admin` CLI is for server and platform operators:

```bash
supacloud-admin status
supacloud-admin ssh ping
supacloud-admin ssh install --public_domain api.example.com --studio_domain studio.example.com
supacloud-admin ssh diagnose
supacloud-admin project list
supacloud-admin project create --name my-app
supacloud-admin project delete --ref <ref>
supacloud-admin project pause --ref <ref>
supacloud-admin platform metrics
```

#### Management API

The REST API runs on port 9090 with Swagger documentation at `/swagger`.

```bash
# Create project
curl -X POST http://localhost:9090/v1/projects \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "My Project", "region": "local"}'

# List projects
curl http://localhost:9090/v1/projects \
  -H "Authorization: Bearer $MASTER_TOKEN"

# Get API keys
curl http://localhost:9090/v1/projects/<ref>/api-keys \
  -H "Authorization: Bearer $MASTER_TOKEN"
```

**Core API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/v1/projects` | List all projects |
| POST | `/v1/projects` | Create project |
| GET | `/v1/projects/:ref` | Get project details |
| PATCH | `/v1/projects/:ref` | Update project |
| DELETE | `/v1/projects/:ref` | Delete project (soft) |
| POST | `/v1/projects/:ref/pause` | Pause project |
| POST | `/v1/projects/:ref/restore` | Restore project |
| GET | `/v1/projects/:ref/status` | Get status |
| GET | `/v1/projects/:ref/health` | Get health |
| GET | `/v1/projects/:ref/dashboard/summary` | Cached dashboard summary |
| POST | `/v1/projects/:ref/restart` | Restart services |
| GET | `/v1/projects/:ref/settings` | Get settings |
| PUT | `/v1/projects/:ref/settings` | Update settings |
| GET | `/v1/projects/:ref/api-keys` | Get API keys |
| POST | `/v1/projects/:ref/api-keys/rotate` | Rotate legacy JWT API keys |
| POST | `/v1/projects/:ref/api-keys/rotate-opaque` | Rotate Publishable/Secret keys without changing JWT sessions |
| GET | `/v1/projects/:ref/auth/oauth-server` | Get project OAuth/OIDC status |
| POST | `/v1/projects/:ref/auth/oauth-server/migrate` | Migrate project to OIDC signing keys |
| GET/POST/PUT/DELETE | `/v1/projects/:ref/auth/oauth-clients*` | OAuth client CRUD for the project runtime |
| GET | `/v1/projects/:ref/types/typescript` | Generate TS types |
| PATCH | `/v1/projects/:ref/config/auth` | Configure Auth & Providers |
| GET | `/v1/projects/:ref/secrets` | List Edge Function Secrets |
| POST | `/v1/projects/:ref/secrets` | Upsert Secrets |
| DELETE | `/v1/projects/:ref/secrets/:name` | Delete Secret |

Function management read endpoints under `/v1/projects/:ref/functions*` require project service-role or admin authentication. Public runtime invokes remain on `/functions/v1/*` and continue to use the normal Supabase function auth model.

**Extended API Endpoints:**

| Category | Endpoints | Description |
|----------|-----------|-------------|
| Database | `/v1/projects/:ref/database/*` | SQL query, schema inspection, migrations, defensive pagination |
| Auth | `/v1/projects/:ref/config/auth`, `/v1/projects/:ref/auth/*` | OAuth providers, OAuth/OIDC Provider migration, WeChat/Alipay/DingTalk |
| Frontend | `/v1/projects/:ref/frontend/*` | Pages hosting, deployments, custom domains |
| Webhook | `/v1/webhooks/github` | GitHub webhook for CI/CD auto-deploy |
| Storage | `/v1/storage/*` | Bucket management, file upload, one-time signed uploads, S3 migration |
| Extensions | `/v1/extensions/*` | PostgreSQL extension marketplace |
| Scaling | `/v1/projects/:ref/scaling/*` | Vertical upgrade & horizontal replicas |
| Backups | `/v1/projects/:ref/backups/*` | Database backup & restore |
| Monitor | `/v1/monitor/*` | Database monitoring & health |
| Security | `/v1/security/*` | Firewall rules & SSL certificates |
| Deploy | `/v1/deploy/*` | Edge Function deployment |
| Tasks | `/v1/projects/:ref/tasks/*` | Background task monitoring, including lightweight `summary=true` list mode |
| **Logs SSE** | `GET /v1/projects/:ref/logs/stream` | **Real-time log streaming via Server-Sent Events** |
| **Rate Limit** | `GET/PUT /v1/projects/:ref/gateway/rate-limit` | **Programmable per-project rate limiting (Caddy route policy)** |
| **Gateway Routes** | `GET/POST/PUT/DELETE /v1/projects/:ref/gateway/routes[/:routeId]` | **Controlled custom Caddy routes (proxy, static, redirect, headers, CORS, priority)** |
| **WebSocket** | `ws://host/ws/tasks` | **Real-time task progress notifications** |

#### Runtime Switching

```bash
# Switch Edge Runtime deployment mode
./switch.sh runtime embedded   # Managed by supacloud.service
./switch.sh runtime external   # Standalone supacloud-edge-runtime.service

# Switch storage backend
./switch.sh storage juicefs    # or: minio, external

# Show current configuration
./switch.sh status
```

**Edge Runtime Architecture:**

```
SupaCloud (:9090)          Edge Runtime (EDGE_RUNTIME_PORT, default :9005)
├── Management API    ←──  supacloud.service manages by default
├── Web Console            ├── Elysia Server
├── SSE Log Stream         ├── Worker Thread Pool (4 threads)
├── WebSocket /ws/tasks    ├── Deno Compat Shim
└── Static Assets (ETag)   ├── URL Import Plugin
                           └── /preheat (zero cold-start)

Edge Runtime parent ── internal capability ──► pgredis-runtime (:9010)
                                             ├── per-tenant PostgreSQL pool
                                             └── bounded L1 + LISTEN/NOTIFY

Caddy Gateway (Admin API-driven):
  Automatic HTTPS, route JSON publishing, security headers, rate limiting, CORS
  /api/*        → :9090
  /functions/*  → :9090 (sdk-proxy, async enqueue + sync relay)
```

SupaCloud never hand-edits a Caddyfile in production. The Management API keeps the full Caddy config as JSON in memory (`GatewayService`), and on every route / rate-limit / cert change it:
1. renders the complete Caddy JSON config,
2. validates it with `caddy validate --config <tmp>`,
3. hot-loads it via `POST /load` on the Caddy Admin API (`CADDY_ADMIN_URL`, default `http://127.0.0.1:2019`),
4. atomically persists the applied JSON to `CADDY_CONFIG_PATH` for reboot-time hydration, and drops a `DO-NOT-EDIT.txt` next to it.

The packaged Caddyfile only enables the Admin API listener and a minimal catch-all for bootstrap; tenant routing, TLS, CORS and rate limiting are all owned by the injected JSON. `GET/POST/PUT/DELETE /v1/projects/:ref/gateway/routes[/:routeId]` and `POST /v1/projects/:ref/gateway/config` are the user-facing surface that drives these JSON updates.

Startup source differs by deployment mode: systemd installs run `supacloud-caddy run --config /etc/supacloud/caddy/config.json` (JSON only, no Caddyfile, with an initial JSON seeded by `install.sh`); the docker `self-host` and `dev` stacks boot the official `caddy` image with a bootstrap-only Caddyfile (`admin 0.0.0.0:2019` + `auto_https off` + a `503` placeholder), then the Management API publishes the full JSON config via `POST /load` once it is healthy, retrying with backoff until Caddy is reachable. Either way the live routing config is the JSON injected through the Admin API.

Additionally, the Management API runs a periodic `gateway-health.worker` that polls the Caddy Admin API; when it detects a transition from unreachable back to reachable (e.g. Caddy restarted under systemd or the container restarted under docker), it triggers `rebuildAllTenantConfigs()` to re-publish the full route JSON so the live config stays consistent with the in-memory state, giving both deployment modes self-healing.

See [docs/gateway-customization.md](docs/gateway-customization.md) for the full field reference, curl examples (reverse proxy, static hosting, HTTPS upstream), rate-limit tiers, custom path rate limits, and how custom routes compose with tenant CORS.

Default installs use `EDGE_RUNTIME_MODE=embedded`, meaning `supacloud.service` starts the Bun Edge Runtime child process itself. A separate `supacloud-edge-runtime.service` is available for `EDGE_RUNTIME_MODE=external`, but you should not run both modes at the same time.

`pgredis-runtime` is a separate private data-plane service. The Edge parent mints a short-lived, project-scoped capability for each request; cached Worker modules only see the stable `globalThis.SupaCloud.pgredis` facade and never receive PostgreSQL credentials, connection pools, L1 state, or the runtime signing secret. The service is not routed by Caddy and exposes no host/container port. Its Edge v1 surface is KV/TTL only. Authenticated operators use the Web Console or Management API proxy for bounded runtime status, exact-key operations, and confirmed project-namespace flushes; browsers never call port `9010` directly. PGMQ remains the only platform queue, while Caddy remains the gateway rate limiter.

### Background Function Routing

Public Edge Function traffic now enters through the Management API first:

- `/functions/v1/*` is routed to `:9090`
- `sdk-proxy` decides whether the call should:
  - enqueue a background task and return `202 Accepted`
  - or relay synchronously to the Bun Edge Runtime
- browser and `supabase-js` callers can keep using the stock `functions.invoke()` API

This gives SupaCloud a stable control point for:

- async enqueue
- retries / timeout defaults
- idempotency
- request envelope capture
- per-function background route policy

For `supabase-js` compatibility, foreground invokes still use the standard:

```ts
await supabase.functions.invoke("my-function", { body: {...} })
```

Background execution is activated through server-side function config via `background_routes`.

`background_routes` is the preferred production model for heavy paths like:

- `/generate/crop`
- `/generate/matting`
- `/generate/video`

because it does not depend on the browser successfully forwarding custom headers.

### Realtime Routing And Recovery

Realtime traffic also enters through the Management API first:

- `/realtime/v1/websocket` is routed to `:9090`
- the Management API owns the websocket upgrade and proxies upstream Realtime traffic
- Caddy should not point browser websocket traffic directly at the Elixir Realtime container

This avoids tenant/path mismatches such as:

- `/realtime/v1/websocket` being rewritten into the wrong upstream `/socket` path
- browser websocket requests being interpreted as the wrong tenant

If Realtime subscriptions fail after installation or migration, SupaCloud now includes one-off reconciliation commands:

```bash
cd packages/management-api
bun run realtime:reconcile
bun run realtime:reconcile-schema
```

Use them to:

- register any missing Realtime tenants
- repair tenant connection metadata
- grant required `realtime` schema privileges in project databases
- add `public.tasks` to the `supabase_realtime` publication and set `REPLICA IDENTITY FULL`

For new installs, `install.sh` now generates a valid `REALTIME_DB_ENC_KEY`, which prevents the historical `Bad key size` failure during tenant registration.

### PostgREST Runtime Lifecycle

Each project keeps a dedicated PostgREST unit, but Management API now treats it as a managed runtime component with explicit desired state:

- `GET /v1/projects/:ref/services/postgrest/status`
- `POST /v1/projects/:ref/services/postgrest/start|stop|restart|pause|resume`

The desired state is stored in dedicated project metadata columns (`postgrest_desired`, `postgrest_actual`, `postgrest_health`, and related timestamps), and the runtime reconcile worker keeps actual systemd state aligned with it. This is explicit lifecycle management, not idle auto-shrinking, so request-path performance stays unchanged.

| Feature | Current Bun Runtime |
|---------|---------------------|
| Memory (200 functions) | **~140MB** |
| Cold start | **< 10ms (with preheat: 0ms)** |
| Warm latency | <1ms |
| Deno code compat | ✅ via shim |
| Isolation | Worker Thread |

#### CLI Entry Points

For human operators, the CLI split is now:

- `@supacloud/cli` / `supacloud-cli`: project-scoped user CLI with `.env` auto-link defaults
- `supacloudctl cli ...`: unified local entrypoint. Normal dispatch is local-only and does not contact npm; use `supacloudctl check-update cli` explicitly when needed.
- `@supacloud/admin` / `supacloud-admin`: server and platform administration CLI
- `supacloudctl admin ...`: unified local entrypoint with the same offline-by-default behavior; use `supacloudctl check-update admin` explicitly.
- Use `npx @supacloud/admin ssh upgrade --version <management-version> --edge_runtime_version <edge-version>` for the verified Management, Web Console, and external Edge Runtime transaction.
- `/usr/local/bin/supacloud` remains the active server binary, but all supported upgrades use Admin. Protected offline upgrades use Admin's verified local transport, which executes the authenticated target runner; do not run the bundle runner manually or let the installed prior release execute a target-specific transaction.


### Project Structure

```
supacloud/
├── install.sh                  # One-click deployment script
├── setup.sh                    # Remote setup bootstrap
├── switch.sh                   # Runtime/storage switching tool
├── supacloud                   # CLI management tool (shell wrapper)
├── config.env                  # Read-only tracked defaults template
├── packages/
│   ├── management-api/         # REST API server (Bun + Elysia)
│   │   ├── src/
│   │   │   ├── routes/         # 20 route modules (projects, auth, frontend, webhook, ws, logs, etc.)
│   │   │   ├── services/       # 20 service modules
│   │   │   ├── cli/            # CLI subcommands (lifecycle, project)
│   │   │   ├── db/             # Database layer, migrations, withRetry & graceful degradation
│   │   │   ├── middleware/     # Auth middleware
│   │   │   ├── infra/          # Health checker
│   │   │   ├── install.ts      # Interactive installer
│   │   │   ├── upgrade.ts      # Upgrade wizard
│   │   │   └── doctor.ts       # System diagnostics
│   │   └── tests/              # Unit (17) & integration tests
│   ├── cli/                    # Project user CLI
│   │   └── src/
│   ├── admin/                  # Platform admin CLI
│   │   └── src/
│   ├── supacloud-lite/          # Bun + PGlite single-project Supabase-compatible runtime
│   │   └── README.md            # Lite usage, migration, and compatibility guide
│   ├── edge-runtime/           # Bun Edge Functions runtime
│   │   ├── server.ts           # Elysia server (EDGE_RUNTIME_PORT, default :9005) + /preheat endpoint
│   │   ├── worker-pool.ts      # Fixed-size Worker Thread Pool + preheat()
│   │   ├── worker-executor.ts  # Function loader + LRU cache + preheat msg
│   │   ├── deno-compat.ts      # Deno API compatibility shim
│   │   ├── url-import-plugin.ts# Bun Plugin: URL import interception
│   │   └── shims/              # Deno std library replacements
│   └── web-console/            # SvelteKit management dashboard
│       └── src/                # Components, routes, assets
├── scripts/
│   └── lib/                    # Shell script modules
│       ├── db_manager.sh       # Database lifecycle
│       ├── gateway provider    # Caddy route publishing is managed in management-api
│       ├── tenant_runtime.sh   # Tenant PostgREST & GoTrue runtime
│       ├── function_manager.sh # Edge Functions management
│       ├── s3_manager.sh       # Storage backend management
│       ├── jwt_manager.sh      # JWT key generation
│       ├── backup_manager.sh   # Backup operations
│       ├── ha_manager.sh       # High availability
│       ├── security_manager.sh # Firewall & SSL
│       ├── storage_manager.sh  # Storage operations
│       ├── extension_manager.sh# PostgreSQL extensions
│       ├── global_router.ts    # Global routing logic
│       └── worker_runner.ts    # Background worker
├── infra/
│   ├── os/                     # OS-level configurations
│   └── postgres/               # PostgreSQL configurations
├── docs/                       # 15 documentation files
│   ├── deploy-guide.md         # Deployment guide
│   ├── architecture-multi-tenant.md  # Architecture design
│   ├── china-oauth-integration.md    # China OAuth (WeChat, etc.)
│   └── ...                     # See docs/README.md for full index
└── .github/
    └── workflows/              # CI/CD (build-studio, management-api, release)
```

### Configuration

`config.env` is a read-only tracked defaults template. Installer-owned input is persisted at `/etc/supabase/install.env`; Management API runtime state is kept separately at `/etc/supabase/management-api.env`. Do not copy runtime state over the installation input.

Key installation settings:

| Variable | Description | Default |
|----------|-------------|---------|
| `SUPABASE_PUBLIC_DOMAIN` | Global API gateway domain | Production required; installer can auto-generate |
| `SUPABASE_STUDIO_DOMAIN` | Global console domain | Auto-derived from API domain if empty |
| `S3_STORAGE_TYPE` | Storage backend | `juicefs` |
| `TUS_MAX_SIZE` | Resumable upload maximum size | `524288000` (500 MiB) |
| `TUS_MAX_CHUNK_SIZE` | Resumable upload chunk maximum size | `16777216` (16 MiB) |
| `EDGE_RUNTIME` | Functions runtime | `bun` |
| `PG_VERSION` | PostgreSQL version | `18` |
| `PIGSTY_VERSION` | Pigsty version | `v4.4.0` |
| `SUPACLOUD_LOGS_ENABLED` | 内置采集器 + VictoriaLogs 项目日志（不使用 Logflare） | `true` |
| `SUPACLOUD_PIPELINES_ENABLED` | Pinned Supabase ETL runtime for BigQuery CDC Pipelines | `true` |

### Documentation

- [Documentation Index](docs/README.md)
- [Deployment Guide](docs/deploy-guide.md)
- [Multi-Tenant Architecture](docs/architecture-multi-tenant.md)
- [OAuth 2.1 / OIDC Provider](docs/oauth-oidc-provider.md)
- [China OAuth Integration](docs/china-oauth-integration.md)
- [Pigsty Documentation](https://pigsty.cc/)
- [Supabase Self-Hosting](https://supabase.com/docs/guides/self-hosting)

---
