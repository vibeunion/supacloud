# SupaCloud

[English](#english) | [中文](#chinese)

---

<a name="english"></a>
## English

**SupaCloud** is a next-generation, ultra-lightweight multi-tenant PaaS for self-hosting Supabase. Built on **Pigsty**, it enables you to run multiple isolated Supabase projects efficiently on a single server.

### Key Features

- **Multi-Tenant Architecture**: Run multiple isolated Supabase projects with shared infrastructure
- **Management API**: Full REST API (60+ endpoints) for complete project lifecycle management
- **Web Console**: Modern SvelteKit management dashboard with authentication
- **CLI Compatibility**: Native support for the official `supabase` CLI (login, gen types, edge functions)
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

# 2. Build Management API, Edge Runtime, Caddy, and Web Console artifacts
bun --cwd packages/management-api install
bun --cwd packages/management-api run build:linux
bun --cwd packages/edge-runtime install
bun --cwd packages/edge-runtime run build:linux
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

Production servers upgrade by replacing the released Linux binary at `/usr/local/bin/supacloud`; they do not need to `git pull` application source during normal upgrades.

```bash
sudo supacloud upgrade --yes
```

Install and upgrade downloads are direct-first. Configure a trusted proxy only when an explicit fallback is required:

```bash
sudo SUPACLOUD_GITHUB_PROXY=https://your-trusted-proxy.example supacloud upgrade --yes
```

Release artifacts require same-release SHA256 verification and GitHub build provenance attestation. `SUPACLOUD_ALLOW_UNVERIFIED_RELEASE=true` is an emergency break-glass mode that retains SHA256 verification but must not be a normal installation setting.

Published release assets:

- `supacloud-linux-amd64` and `supacloud-linux-arm64` are the production install/upgrade binaries.
- `supacloud-macos-amd64` and `supacloud-macos-arm64` are published for local development and diagnostics.

**Docker Compose Self-Host (PostgreSQL 18)**

```bash
cd docker/self-host
python3 init-env.py --public-url https://api.example.com --studio-url https://studio.example.com > .env
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
supacloud-cli storage list_buckets --ref <ref>
```

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
| GET | `/v1/oauth/authorize` | CLI OAuth Login |

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
| **Gateway Routes** | `GET/POST/PUT/DELETE /v1/projects/:ref/gateway/routes[/:routeId]` | **Controlled custom Caddy routes (hosts, path, upstream, headers, CORS, priority)** |
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
SupaCloud (:9090)          Edge Runtime (:9000)
├── Management API    ←──  supacloud.service manages by default
├── Web Console            ├── Elysia Server
├── SSE Log Stream         ├── Worker Thread Pool (4 threads)
├── WebSocket /ws/tasks    ├── Deno Compat Shim
└── Static Assets (ETag)   ├── URL Import Plugin
                           └── /preheat (zero cold-start)

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
- `supacloudctl cli ...`: unified local entrypoint. It checks the npm `latest` dist-tag only to print an update notice and always runs the installed `@supacloud/cli` version.
- `@supacloud/admin` / `supacloud-admin`: server and platform administration CLI
- `supacloudctl admin ...`: unified local entrypoint with the same notify-only latest check for `@supacloud/admin`.
- On installed servers, `/usr/local/bin/supacloud` remains the compiled server binary; server upgrades still use `sudo supacloud upgrade --yes`.


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
│   ├── edge-runtime/           # Bun Edge Functions runtime
│   │   ├── server.ts           # Elysia server (:9000) + /preheat endpoint
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
| `ENABLE_ANALYTICS` | Logflare analytics | `true` |

### Documentation

- [Documentation Index](docs/README.md)
- [Deployment Guide](docs/deploy-guide.md)
- [Multi-Tenant Architecture](docs/architecture-multi-tenant.md)
- [OAuth 2.1 / OIDC Provider](docs/oauth-oidc-provider.md)
- [China OAuth Integration](docs/china-oauth-integration.md)
- [Pigsty Documentation](https://pigsty.cc/)
- [Supabase Self-Hosting](https://supabase.com/docs/guides/self-hosting)

---

<a name="chinese"></a>
## 中文

**SupaCloud** 是为 Supabase 私有化部署打造的下一代超轻量级多租户 PaaS 平台。基于 **Pigsty** 构建，可在单台服务器上高效运行多个隔离的 Supabase 项目。

### 核心特性

- **多租户架构**: 共享基础设施，运行多个隔离的 Supabase 项目
- **Management API**: 完整的 REST API（60+ 个端点）管理项目及周边配置生命周期
- **Web 管理面板**: 现代 SvelteKit 管理面板，内置登录认证
- **CLI 生态兼容**: 完全兼容 Supabase 官方命令行体系（登录鉴权、数据库类型推导、云函数发布）
- **CLI 工具**: `supacloud-cli` 面向项目使用者，`supacloud-admin` 面向服务器管理员；可选用 `supacloudctl` 作为本地统一分发入口
- **SupaCloud Pages**: 前端静态站点托管，支持 GitHub Webhook 自动部署
- **Pigsty 驱动**: 企业级 PostgreSQL，内置 Grafana 监控
- **一键部署**: 通过 `install.sh` 全自动安装
- **JuiceFS 存储**: 基于 PostgreSQL Large Objects (LO) 后端，极致轻量
- **Caddy 网关**: Automatic HTTPS、Admin API 驱动的动态路由发布、安全响应头与编程式限流
- **自动扩缩容**: 基于负载指标的垂直提升与水平副本扩展
- **Bun Edge Runtime**: 基于 Bun.js + Elysia Worker Pool，内置 Deno 兼容层以兼容旧函数代码
- **SSE 实时日志**: 基于 Server-Sent Events 的实时日志流，`journalctl --follow` 推送
- **原生异步队列**: 基于 PostgreSQL LISTEN/NOTIFY 的零依赖高并发调度底座，支持 AI 大模型任务与 MQTT 消息队列
- **WebSocket 任务通知**: 基于 Bun 原生 WebSocket 的实时任务进度推送
- **DB 优雅降级**: 指数退避重试 + 503 Service Unavailable，PostgreSQL 短暂不可用时不丢请求
- **控制平面加固**: 函数管理读接口鉴权、一次性 signed upload、防御性分页和安全的存储元数据解析
- **Edge Function 预热**: 部署后自动预导入模块，消除首次请求冷启动
- **项目级 OAuth/OIDC Provider**: 支持项目迁移到 ES256 OIDC signing keys、授权端点、JWKS 和 OAuth client 管理
- **国内 OAuth**: 内置微信、支付宝、钉钉登录集成
- **CI/CD 集成**: GitHub Webhook 自动化部署
- **完善测试**: 400+ 单元、集成和结构回归测试

### SupaCloud 与 Supabase 的区别

SupaCloud 更准确的定位是：**面向自托管场景的多租户 Supabase 控制平面**，而不是 Supabase Cloud 的镜像复刻。

简版结论：

- **SupaCloud**: 适合你在自有服务器上托管多个隔离项目，并需要内置控制台、项目生命周期 API、任务队列能力和前端托管能力。
- **Supabase Cloud**: 适合你直接购买托管平台，需要托管备份/PITR、托管日志和官方 Branching。
- **Supabase Self-Hosted**: 适合你要官方原生自托管栈，并愿意自己承担 Docker 与基础设施运维。

详细功能对比：

- [docs/supacloud-vs-supabase.md](./docs/supacloud-vs-supabase.md)

### 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                  Management API (:9090)                      │
│            Bun + Elysia + TypeScript + 自动扩缩容            │
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
│                       共享基础设施                            │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ PostgreSQL │  │   Caddy    │  │  JuiceFS   │            │
│  │  (Pigsty)  │  │    网关    │  │  (PG-LO)   │            │
│  └────────────┘  └────────────┘  └────────────┘            │
│                  ┌────────────┐                             │
│                  │  Grafana   │                             │
│                  │  (监控)    │                             │
│                  └────────────┘                             │
└─────────────────────────────────────────────────────────────┘
```

### 快速开始

#### 系统要求

| 项目 | 最低配置 | 推荐配置 |
|------|----------|----------|
| CPU | 2 核 | 4 核+ |
| 内存 | 2GB | 4GB+ |
| 磁盘 | 40GB | 100GB+ SSD |
| 系统 | CentOS 9, Ubuntu 22/24, Debian 12 | CentOS 9 |

#### 人类入口

**项目使用者 CLI**

```bash
npm install -g @supacloud/cli

supacloud-cli status
supacloud-cli project get
supacloud-cli project logs --log_type database
supacloud-cli frontend list --ref <project-ref>
```

`supacloud-cli` 默认是项目级 CLI，会优先从当前目录 `.env` 自动绑定项目。
项目 CLI 不再提供名为 `supacloud` 的兼容别名：该名称只保留给 `/usr/local/bin/supacloud` 服务端二进制。本地统一分发入口必须明确使用 `supacloudctl`。

- `SUPABASE_URL` 或 `SUPACLOUD_API_URL`
- `SUPABASE_SERVICE_ROLE_KEY` 或 `SUPACLOUD_API_TOKEN`

**服务器管理员 CLI**

```bash
npx @supacloud/admin status
npx @supacloud/admin ssh ping
npx @supacloud/admin ssh install --public_domain api.example.com --studio_domain studio.example.com
npx @supacloud/admin project create --name my-app
```

安装、升级、SSH 诊断、tenant 运维、平台级项目管理都应放在 `supacloud-admin`。

#### 安装部署

**一键安装（推荐）**

```bash
curl -fsSL https://raw.githubusercontent.com/zuohuadong/supacloud/main/setup.sh | sudo bash
```

Root 引导脚本始终从官方仓库获取。Release/API 下载默认先直连 GitHub，仅在明确配置时回退到可信代理：

```bash
curl -fsSL https://raw.githubusercontent.com/zuohuadong/supacloud/main/setup.sh \
  | sudo env SUPACLOUD_GITHUB_PROXY=https://your-trusted-proxy.example bash
```

**源码/开发环境手动安装（仅本地产物）**

生产服务器应使用上方经过校验的 `setup.sh` 一键安装链路。源码仓库不包含 Release 产物，因此必须先构建全部组件，并显式启用本地产物模式：

```bash
# 1. 从官方仓库下载代码
git clone https://github.com/zuohuadong/supacloud.git
cd supacloud

# 2. 构建 Management API、Edge Runtime、Caddy 与 Web Console
bun --cwd packages/management-api install
bun --cwd packages/management-api run build:linux
bun --cwd packages/edge-runtime install
bun --cwd packages/edge-runtime run build:linux
bun --cwd packages/web-console install --frozen-lockfile
bun --cwd packages/web-console run build
mkdir -p .local/bin dist
GOBIN="$PWD/.local/bin" go install github.com/caddyserver/xcaddy/cmd/xcaddy@v0.4.5
PATH="$PWD/.local/bin:$PATH" OUT_DIR="$PWD/dist" bash scripts/build_supacloud_caddy.sh

# 3. 显式使用本地产物安装（参数会持久化到 /etc/supabase/install.env）
sudo env SUPACLOUD_SETUP_ARTIFACT_MODE=local \
  bash install.sh --ip 1.2.3.4 --domain api.example.com --s3 juicefs

# 4. 启用命令行工具
source /etc/profile.d/supacloud.sh
```

**生产环境升级**

生产服务器升级时直接替换 `/usr/local/bin/supacloud` 中的 Linux Release 二进制文件，常规升级不需要在服务器上 `git pull` 源码。

```bash
sudo supacloud upgrade --yes
```

安装和升级下载默认先直连 GitHub。只有需要明确回退时才配置可信代理：

```bash
sudo SUPACLOUD_GITHUB_PROXY=https://your-trusted-proxy.example supacloud upgrade --yes
```

Release 产物必须同时通过同一 Release 的 SHA256 和 GitHub build provenance attestation。`SUPACLOUD_ALLOW_UNVERIFIED_RELEASE=true` 仅用于紧急 break-glass，仍会校验 SHA256，不应作为常规安装配置。

发布产物约定：

- `supacloud-linux-amd64` 和 `supacloud-linux-arm64` 用于生产安装和升级。
- `supacloud-macos-amd64` 和 `supacloud-macos-arm64` 仅用于本地开发、诊断和验证。

**命令行参数详解:**
| 参数 | 说明 | 示例 |
|--------|-------------|---------| 
| `--ip` | 指定内网 IP | `--ip 10.0.0.5` |
| `--domain` | 指定 API 域名 | `--domain supa.com` |
| `--studio` | 指定 Studio 域名| `--studio studio.com`|
| `--s3` | 指定存储类型 | `juicefs`、`minio` 或 `external` |
| `--password`| 统一设置初始密码 | `--password mysecret` |

### 项目管理

#### 用户 CLI：`supacloud-cli`

`supacloud-cli` 默认是项目级 CLI，用于围绕单个项目的部署、日志、数据库与资源管理：

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
supacloud-cli storage list_buckets --ref <ref>
```

复杂 SQL、pgvector 查询、单请求事务块建议使用 `--file`，不要依赖 shell 字符串转义。

```sql
BEGIN;
INSERT INTO audit_events(message) VALUES ('started');
INSERT INTO audit_events(message) VALUES ('finished');
COMMIT;
```

SupaCloud 支持单个 SQL 请求内的事务块，也会在 migration endpoint 内部使用事务；不建议提供 `/transaction/begin`、`/transaction/query`、`/transaction/commit` 这类长连接 HTTP 事务 API。应用侧长事务请使用 Postgres 直连 DSN 配合 `pg`、`postgres.js` 等驱动。

pgvector 示例：

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

`supacloud-cli` 有意不承载平台安装、升级、SSH 诊断、tenant runtime 管理，以及项目创建/删除/暂停这类平台级命令。

#### 管理员 CLI：`supacloud-admin`

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

REST API 运行在 9090 端口，Swagger 文档地址：`/swagger`

```bash
# 创建项目
curl -X POST http://localhost:9090/v1/projects \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "我的项目", "region": "local"}'

# 列出项目
curl http://localhost:9090/v1/projects \
  -H "Authorization: Bearer $MASTER_TOKEN"

# 获取 API 密钥
curl http://localhost:9090/v1/projects/<ref>/api-keys \
  -H "Authorization: Bearer $MASTER_TOKEN"
```

**核心 API 端点：**

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/v1/projects` | 获取项目列表 |
| POST | `/v1/projects` | 创建项目 |
| GET | `/v1/projects/:ref` | 获取项目详情 |
| PATCH | `/v1/projects/:ref` | 更新项目 |
| DELETE | `/v1/projects/:ref` | 删除项目（软删除） |
| POST | `/v1/projects/:ref/pause` | 暂停项目 |
| POST | `/v1/projects/:ref/restore` | 恢复项目 |
| GET | `/v1/projects/:ref/status` | 获取状态 |
| GET | `/v1/projects/:ref/health` | 获取健康状态 |
| GET | `/v1/projects/:ref/dashboard/summary` | 获取带缓存的控制台汇总数据 |
| POST | `/v1/projects/:ref/restart` | 重启服务 |
| GET | `/v1/projects/:ref/settings` | 获取配置 |
| PUT | `/v1/projects/:ref/settings` | 更新配置 |
| GET | `/v1/projects/:ref/api-keys` | 获取 API 密钥 |
| POST | `/v1/projects/:ref/api-keys/rotate` | 轮换旧版 JWT API 密钥 |
| POST | `/v1/projects/:ref/api-keys/rotate-opaque` | 独立轮换 Publishable/Secret Key，不影响 JWT 会话 |
| GET | `/v1/projects/:ref/auth/oauth-server` | 获取项目 OAuth/OIDC 状态 |
| POST | `/v1/projects/:ref/auth/oauth-server/migrate` | 将项目迁移到 OIDC 签名密钥 |
| GET/POST/PUT/DELETE | `/v1/projects/:ref/auth/oauth-clients*` | 项目运行时的 OAuth 客户端管理 |
| GET | `/v1/projects/:ref/types/typescript` | 自动生成 TypeScript 类型 |
| PATCH | `/v1/projects/:ref/config/auth` | 自定义鉴权及三方 OAuth |
| GET | `/v1/projects/:ref/secrets` | 管理 Edge Functions Secrets |
| GET | `/v1/oauth/authorize` | 授权官方 CLI OAuth 登录 |

`/v1/projects/:ref/functions*` 下的函数管理读取接口需要 project service role 或 admin 鉴权。公开函数调用仍走 `/functions/v1/*`，继续使用标准 Supabase 函数鉴权模型。

**扩展 API 端点：**

| 分类 | 端点 | 说明 |
|------|------|------|
| 数据库 | `/v1/projects/:ref/database/*` | SQL 查询、Schema 检查、数据迁移、防御性分页 |
| 鉴权 | `/v1/projects/:ref/config/auth`, `/v1/projects/:ref/auth/*` | OAuth 登录、OAuth/OIDC Provider 迁移、微信/支付宝/钉钉 |
| 前端托管 | `/v1/projects/:ref/frontend/*` | Pages 托管、自动部署、自定义域名 |
| Webhook | `/v1/webhooks/github` | GitHub Webhook CI/CD 自动部署 |
| 存储 | `/v1/storage/*` | Bucket 管理、文件上传、一次性 signed upload、S3 迁移 |
| 扩展 | `/v1/extensions/*` | PostgreSQL 扩展市场 |
| 扩缩容 | `/v1/projects/:ref/scaling/*` | 垂直升级与水平副本 |
| 备份 | `/v1/projects/:ref/backups/*` | 数据库备份与恢复 |
| 监控 | `/v1/monitor/*` | 数据库监控与健康检查 |
| 安全 | `/v1/security/*` | 防火墙规则与 SSL 证书 |
| 部署 | `/v1/deploy/*` | Edge Function 部署 |
| 任务 | `/v1/projects/:ref/tasks/*` | 后台 AI/通用异步任务生命周期观测与监控，支持 `summary=true` 轻量列表 |
| **日志 SSE** | `GET /v1/projects/:ref/logs/stream` | **实时日志流（Server-Sent Events）** |
| **限流** | `GET/PUT /v1/projects/:ref/gateway/rate-limit` 及 `custom-rate-limits` | **编程式架构与客户端路由自定限流（Caddy 路由策略）** |
| **网关路由** | `GET/POST/PUT/DELETE /v1/projects/:ref/gateway/routes[/:routeId]` | **受控自定义 Caddy 路由（域名、路径、上游、请求头、CORS、优先级）** |
| **WebSocket** | `ws://host/ws/tasks` | **实时任务进度推送** |

#### 运行时切换

```bash
# 切换 Edge Runtime 部署模式
./switch.sh runtime embedded   # 由 supacloud.service 管理
./switch.sh runtime external   # 独立 supacloud-edge-runtime.service

# 切换存储后端
./switch.sh storage juicefs    # 或: minio, external

# 查看当前配置
./switch.sh status
```

**Edge Runtime 架构 (Bun 模式):**

```
SupaCloud (:9090)          Edge Runtime (:9000)
├── Management API    ←──  默认由 supacloud.service 管理
├── Web Console            ├── Elysia Server
├── SSE 日志流              ├── Worker 线程池 (4 线程，固定)
├── WebSocket /ws/tasks    ├── Deno 兼容层
└── 静态资源 (ETag/304)    ├── URL Import 插件
                           └── /preheat (零冷启动预热)

Caddy 网关 (Admin API 驱动):
  Automatic HTTPS、动态路由 JSON 发布、安全响应头、限流、CORS
  /api/*        → :9090 (管理 API)
  /functions/*  → :9090 (sdk-proxy，异步入队 + 同步转发)
```

生产环境从不手改 Caddyfile。Management API 将完整的 Caddy 配置以 JSON 形式保存在内存中（`GatewayService`），每次路由 / 限流 / 证书变更都会：
1. 渲染出完整的 Caddy JSON 配置；
2. 用 `caddy validate --config <tmp>` 校验；
3. 通过 Caddy Admin API 的 `POST /load`（`CADDY_ADMIN_URL`，默认 `http://127.0.0.1:2019`）热加载；
4. 将已应用的 JSON 原子写入 `CADDY_CONFIG_PATH`，用于重启后 hydrate 恢复，并在同目录写入 `DO-NOT-EDIT.txt`。

打包的 Caddyfile 只负责开启 Admin API 监听和最小 catch-all 引导；租户路由、TLS、CORS 与限流全部由注入的 JSON 接管。`GET/POST/PUT/DELETE /v1/projects/:ref/gateway/routes[/:routeId]` 和 `POST /v1/projects/:ref/gateway/config` 就是驱动这些 JSON 更新的用户侧接口。

启动来源因部署模式而异：systemd 安装用 `supacloud-caddy run --config /etc/supacloud/caddy/config.json`（纯 JSON，无 Caddyfile，初始 JSON 由 `install.sh` 预置）；docker 的 `self-host` 和 `dev` 栈以官方 `caddy` 镜像 + 纯引导 Caddyfile（`admin 0.0.0.0:2019` + `auto_https off` + `503` 占位）启动，Management API 健康（监听 `:9090`）后通过 `POST /load` 发布完整 JSON 配置，并带退避重试直到 Caddy 可达。无论哪种模式，真正生效的路由配置都是经 Admin API 注入的 JSON。

此外，Management API 运行周期性 `gateway-health.worker` 轮询 Caddy Admin API；一旦检测到"从不可达恢复可达"（如 systemd 下 caddy 重启或 docker 下容器重启），即触发 `rebuildAllTenantConfigs()` 重新发布完整路由 JSON，保持生效配置与内存态一致，两种部署模式都具备自愈能力。

完整字段说明、curl 示例（反代、静态托管、HTTPS 上游）、限流 tier、单路径自定义限流，以及自定义路由与租户 CORS 的组合行为，见 [docs/gateway-customization.md](docs/gateway-customization.md)。

默认安装使用 `EDGE_RUNTIME_MODE=embedded`，也就是由 `supacloud.service` 直接拉起 Bun Edge Runtime 子进程。`EDGE_RUNTIME_MODE=external` 时可以改用独立的 `supacloud-edge-runtime.service`，但两种模式不能同时运行，否则会争抢 `9000` 端口。

| 特性 | 当前 Bun Runtime |
|------|------------------|
| 内存 (200 函数) | **~140MB** |
| 冷启动 | **< 10ms (预热后: 0ms)** |
| 预热延迟 | <1ms |
| Deno 代码兼容 | ✅ 兼容层 |
| 隔离级别 | Worker 线程 |
| 用户函数改动 | **零改动** |

### 后台函数路由

公开 Edge Function 流量先进入 Management API：

- `/functions/v1/*` 路由到 `:9090`
- `sdk-proxy` 根据函数配置决定异步入队并返回 `202 Accepted`，或同步转发到 Bun Edge Runtime
- 浏览器和 `supabase-js` 调用方继续使用标准 `functions.invoke()`

后台执行通过服务端函数配置 `background_routes` 开启。对 `/generate/crop`、`/generate/matting`、`/generate/video` 这类耗时路径，推荐使用 `background_routes`，避免依赖浏览器自定义请求头。

### Realtime 路由与恢复

Realtime 流量也先进入 Management API：

- `/realtime/v1/websocket` 路由到 `:9090`
- Management API 负责 websocket upgrade 并代理到上游 Realtime
- Caddy 不应把浏览器 websocket 流量直接指向 Elixir Realtime 容器

安装或迁移后如果 Realtime 订阅异常，可以运行：

```bash
cd packages/management-api
bun run realtime:reconcile
bun run realtime:reconcile-schema
```

### PostgREST 运行时生命周期

每个项目仍然使用独立的 PostgREST 进程，但 Management API 现在把它当成受控运行时组件管理，支持显式 desired state：

- `GET /v1/projects/:ref/services/postgrest/status`
- `POST /v1/projects/:ref/services/postgrest/start|stop|restart|pause|resume`

desired state 保存在项目专用元数据列里（`postgrest_desired`、`postgrest_actual`、`postgrest_health` 及相关时间戳），runtime reconcile worker 会把实际 systemd 状态对齐到它。这里是显式生命周期管理，不做空闲自动收缩，所以请求路径性能不变。

#### CLI 入口

面向真人操作者的命令行现已拆分为：

- `@supacloud/cli` / `supacloud-cli`：项目使用者 CLI，默认从当前目录 `.env` 自动绑定项目
- `supacloudctl cli ...`：统一本地入口，执行前只检查 npm `latest` 并提示更新，始终运行已安装的 `@supacloud/cli` 版本
- `@supacloud/admin` / `supacloud-admin`：服务器管理员 CLI，处理 SSH、安装、升级、租户运维
- `supacloudctl admin ...`：统一本地入口，对 `@supacloud/admin` 使用相同的仅提示更新策略
- 已安装服务器上的 `/usr/local/bin/supacloud` 仍是编译后的服务端二进制，服务端升级继续使用 `sudo supacloud upgrade --yes`


### 项目结构

```
supacloud/
├── install.sh                  # 一键部署脚本
├── setup.sh                    # 远程安装引导
├── switch.sh                   # 运行时/存储切换工具
├── supacloud                   # CLI 管理工具 (Shell 入口)
├── config.env                  # 只读、受 Git 跟踪的默认模板
├── packages/
│   ├── management-api/         # REST API 服务 (Bun + Elysia)
│   │   ├── src/
│   │   │   ├── routes/         # 20 个路由模块 (projects, auth, frontend, webhook, ws, logs 等)
│   │   │   ├── services/       # 20 个服务模块
│   │   │   ├── cli/            # CLI 子命令 (lifecycle, project)
│   │   │   ├── db/             # 数据库层、迁移、withRetry 优雅降级
│   │   │   ├── middleware/     # 认证中间件
│   │   │   ├── infra/          # 健康检查器
│   │   │   ├── install.ts      # 交互式安装器
│   │   │   ├── upgrade.ts      # 升级向导
│   │   │   └── doctor.ts       # 系统诊断
│   │   └── tests/              # 单元测试 (17) & 集成测试
│   ├── cli/                    # 项目使用者 CLI
│   │   └── src/
│   ├── admin/                  # 服务器管理员 CLI
│   │   └── src/
│   ├── edge-runtime/           # Bun 云函数运行时
│   │   ├── server.ts           # Elysia 服务 (:9000) + /preheat 预热端点
│   │   ├── worker-pool.ts      # 固定大小 Worker 线程池 + preheat()
│   │   ├── worker-executor.ts  # 函数加载器 + LRU 缓存 + 预热消息
│   │   ├── deno-compat.ts      # Deno API 兼容层
│   │   ├── url-import-plugin.ts# Bun Plugin: URL import 拦截
│   │   └── shims/              # Deno 标准库替代实现
│   └── web-console/            # SvelteKit 管理面板
│       └── src/                # 组件, 路由, 资源
├── scripts/
│   └── lib/                    # Shell 脚本模块
│       ├── db_manager.sh       # 数据库生命周期
│       ├── gateway provider    # Caddy 路由发布由 management-api 内部管理
│       ├── tenant_runtime.sh   # 租户 PostgREST & GoTrue 运行时
│       ├── function_manager.sh # 云函数管理
│       ├── s3_manager.sh       # 存储后端管理
│       ├── jwt_manager.sh      # JWT 密钥生成
│       ├── backup_manager.sh   # 备份操作
│       ├── ha_manager.sh       # 高可用
│       ├── security_manager.sh # 防火墙 & SSL
│       ├── storage_manager.sh  # 存储操作
│       ├── extension_manager.sh# PostgreSQL 扩展
│       ├── global_router.ts    # 全局路由逻辑
│       └── worker_runner.ts    # 后台 Worker
├── infra/
│   ├── os/                     # 操作系统配置
│   └── postgres/               # PostgreSQL 配置
├── docs/                       # 15 篇技术文档
│   ├── deploy-guide.md         # 部署指南
│   ├── architecture-multi-tenant.md  # 架构设计
│   ├── china-oauth-integration.md    # 国内 OAuth 集成
│   └── ...                     # 详见 docs/README.md 完整索引
└── .github/
    └── workflows/              # CI/CD (build-studio, management-api, release)
```

### 配置说明

`config.env` 仅是只读默认模板。安装输入持久化在 `/etc/supabase/install.env`，Management API 运行时配置独立保存在 `/etc/supabase/management-api.env`；禁止用运行时配置覆盖安装输入。

关键安装配置项：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `SUPABASE_PUBLIC_DOMAIN` | 全局 API 网关域名 | 生产必填；安装器可自动生成 |
| `SUPABASE_STUDIO_DOMAIN` | 全局控制台域名 | 可留空，默认从 API 域名派生 |
| `S3_STORAGE_TYPE` | 存储后端 | `juicefs` |
| `TUS_MAX_SIZE` | 断点续传上传最大大小 | `524288000` (500 MiB) |
| `TUS_MAX_CHUNK_SIZE` | 断点续传分片最大大小 | `16777216` (16 MiB) |
| `EDGE_RUNTIME` | 云函数运行时 | `bun` |
| `PG_VERSION` | PostgreSQL 版本 | `18` |
| `PIGSTY_VERSION` | Pigsty 版本 | `v4.4.0` |
| `ENABLE_ANALYTICS` | Logflare 分析 | `true` |

### 参考文档

- [文档索引](docs/README.md)
- [部署指南](docs/deploy-guide.md)
- [多租户架构设计](docs/architecture-multi-tenant.md)
- [OAuth 2.1 / OIDC Provider](docs/oauth-oidc-provider.md)
- [国内 OAuth 集成](docs/china-oauth-integration.md)
- [Pigsty 官方文档](https://pigsty.cc/)
- [Supabase 自托管文档](https://supabase.com/docs/guides/self-hosting)

## License

MIT
