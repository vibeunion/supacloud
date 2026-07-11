# SupaCloud Multi-tenant Management Solution and Management API Technical Specification

This document details the technical solution design for multi-project management based on Pigsty architecture and the complete technical specification for Management API.

---

## 1. Architecture Overview

Multiple Supabase projects are run with logical isolation by sharing infrastructure (Pigsty PostgreSQL, the SupaCloud Caddy gateway, and object storage).

```
┌─────────────────────────────────────────────────────────────┐
│                    Management API (:9090)                    │
│              Bun + Elysia + Dependency Injection             │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ JwtService   │  │ DbService    │  │ StorageSvc   │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
│         │                 │                 │                │
│         ▼                 ▼                 ▼                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │jwt_manager.sh│  │db_manager.sh │  │storage_mgr.sh│       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                    Shared Infrastructure                     │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐             │
│  │ PostgreSQL │  │   Caddy    │  │ Obj Storage│             │
│  │  (Pigsty)  │  │  Gateway   │  │(JuiceFS/…) │             │
│  └────────────┘  └────────────┘  └────────────┘             │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Data Isolation Strategy

### 2.1 Database Isolation (PostgreSQL)

Each project has its own logical database and user in the Pigsty cluster.

| Resource | Naming Convention | Example |
|----------|-------------------|---------|
| Project Database | `supa_<project_ref>` | `supa_abc123` |
| Project Role | `role_<project_ref>` | `role_abc123` |
| Permissions | Role can only access its own database | Enforced by HBA rules |

### 2.2 Metadata Storage

Dedicated `supacloud_meta` database stores project lifecycle information.

```sql
CREATE DATABASE supacloud_meta;

CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ref VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    db_name VARCHAR(63) NOT NULL,
    db_user VARCHAR(63) NOT NULL,
    db_password VARCHAR(100) NOT NULL,
    jwt_secret VARCHAR(100) NOT NULL,
    anon_key TEXT NOT NULL,
    service_role_key TEXT NOT NULL,
    s3_bucket VARCHAR(63) NOT NULL,
    s3_access_key VARCHAR(100),
    s3_secret_key VARCHAR(100),
    region VARCHAR(50) DEFAULT 'local',
    status VARCHAR(20) DEFAULT 'creating',
    config JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_projects_ref ON projects(ref);
CREATE INDEX idx_projects_status ON projects(status);
```

### 2.3 Storage Isolation

- **Bucket Naming**: `supa-<project_ref>`
- **Credentials**: Independent Access Key / Secret Key per project
- **Supported Backends**: JuiceFS (default), RustFS, Garage, MinIO, External S3

### 2.4 DNS and Routing Isolation

Dynamic Vhost generation via Caddy Admin API-driven routing. Management API publishes Caddy routes programmatically.

| Domain Pattern | Routing Target |
|----------------|----------------|
| `api.example.com` | Shared Caddy Gateway |
| `studio.example.com` | Shared Studio Console |
| `<project>.api.example.com` | Caddy + Tenant Header |

---

## 3. JWT Security Isolation

### 3.1 Independent Keys

Each project generates a unique `JWT_SECRET` (32+ characters) during initialization.

### 3.2 Key Derivation

```
JWT_SECRET → ANON_KEY (role: anon, exp: 10 years)
JWT_SECRET → SERVICE_ROLE_KEY (role: service_role, exp: 10 years)
```

### 3.3 OAuth/OIDC Migration

Projects can be migrated to the Supabase-compatible OAuth 2.1 / OIDC Provider model through:

```http
POST /v1/projects/:ref/auth/oauth-server/migrate
```

Migration is project-scoped and writes ES256 `JWT_KEYS` / `JWT_JWKS` material into the project's Auth config. GoTrue signs new OIDC tokens with `GOTRUE_JWT_KEYS`, and SupaCloud admin proxy calls use short-lived ES256 `service_role` tokens instead of requiring HS256 in `JWT_KEYS`; PostgREST, Storage, Realtime, SDK proxy, and Management API validators verify through the project JWKS.

Existing `anon` and `service_role` API keys remain project-scoped and verifiable during migration. They are not shared across projects or accounts.

### 3.4 Caddy Gateway Integration

Caddy dynamically routes requests for different projects based on `Host` header and the route JSON published by Management API.

---

## 4. Management API Specification

### 4.1 Authentication

- **Master Token**: Stored in `/etc/supabase/master-token.env`
- **Header**: `Authorization: Bearer <MASTER_TOKEN>`
- **Project Scoped Access**: project service-role tokens can access only their own `/v1/projects/:ref/*` routes.
- **Function Management Reads**: `/v1/projects/:ref/functions*` management endpoints require project service-role or admin authentication. Public `/functions/v1/*` runtime invokes are separate and keep the standard Supabase function auth model.

### 4.2 API Endpoints

#### Project Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/v1/projects` | Get all projects list |
| POST | `/v1/projects` | Create new project |
| GET | `/v1/projects/:ref` | Get project details |
| DELETE | `/v1/projects/:ref` | Delete project (soft delete) |
| GET | `/v1/projects/:ref/settings` | Get project config |
| PUT | `/v1/projects/:ref/settings` | Update project config |
| GET | `/v1/projects/:ref/dashboard/summary` | Cached dashboard aggregate for web console hot path |
| GET | `/v1/projects/:ref/status` | Get project running status |
| POST | `/v1/projects/:ref/restart` | Restart project services |
| GET | `/v1/projects/:ref/services` | List service status, including PostgREST desired/actual state and last error |
| GET | `/v1/projects/:ref/services/postgrest/status` | Get PostgREST-only runtime status |
| POST | `/v1/projects/:ref/services/postgrest/start` | Set PostgREST desired state to running and start/repair the unit |
| POST | `/v1/projects/:ref/services/postgrest/stop` | Set PostgREST desired state to stopped and stop/disable the unit |
| POST | `/v1/projects/:ref/services/postgrest/restart` | Restart only the PostgREST unit |
| GET | `/v1/projects/:ref/types/typescript`| Get database TS types (for CLI) |
| PATCH| `/v1/projects/:ref/config/auth` | Set Auth/OAuth/SMTP providers |
| GET | `/v1/projects/:ref/secrets` | Control sensitive variables like edge functions |

#### CLI Ecosystem (Supabase CLI)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/v1/oauth/authorize` | Token issuance page compatible with `supabase login` |

#### Key Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/v1/projects/:ref/api-keys` | Get project API keys |

#### Operational Hardening

- Database list routes normalize pagination inputs before constructing SQL `LIMIT/OFFSET`, so malformed values fall back to safe defaults instead of producing 500 responses.
- Storage signed upload URLs are one-time tokens. The Management API atomically consumes each token with delete-and-return semantics before accepting the upload body.
- Storage object size metadata is cast defensively; non-numeric `metadata->>'size'` values are treated as zero for dashboard and list calculations.
- Storage metadata writes can register a physical compensation action, allowing the service to remove newly copied/uploaded objects if the metadata transaction fails after the physical write.
- PostgREST desired state is stored in dedicated project runtime columns and reconciled against systemd actual state. The first version is explicit lifecycle management only; it does not idle-pause active projects, so REST request-path performance is unchanged.

### 4.3 Request/Response Examples

#### POST /v1/projects

**Request**:
```json
{
  "name": "My Project",
  "region": "local"
}
```

**Response**:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "ref": "abc123xyz",
  "name": "My Project",
  "status": "creating",
  "created_at": "2025-01-29T12:00:00Z"
}
```

#### GET /v1/projects/:ref/api-keys

**Response**:
```json
{
  "anon_key": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.REDACTED_EXAMPLE",
  "service_role_key": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.REDACTED_EXAMPLE"
}
```

---

## 5. Modular Scripts

### 5.1 Script Location

```
/opt/supacloud/scripts/lib/
├── db_manager.sh      # Database management
├── storage_manager.sh # Storage management (JuiceFS/S3)
├── gateway service    # Caddy routing is managed in the Management API gateway provider
└── jwt_manager.sh     # JWT key management
```

### 5.2 Script Interface

#### db_manager.sh

```bash
# Create project database and role
db_manager.sh create <project_ref> <password>

# Delete project database and role
db_manager.sh delete <project_ref>

# Check database status
db_manager.sh status <project_ref>
```

#### storage_manager.sh

```bash
# Create project bucket
storage_manager.sh create <project_ref>

# Delete project bucket
storage_manager.sh delete <project_ref>

# Get credentials
storage_manager.sh credentials <project_ref>
```

#### Gateway routing

Caddy routing is no longer managed through a standalone shell helper. The Management API publishes tenant routes, rate limiting, CORS, and TLS state directly to the Caddy Admin API.

#### jwt_manager.sh

```bash
# Generate project JWT key
jwt_manager.sh generate <project_ref>

# Output: JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY
```

---

## 6. Deployment Configuration

### 6.1 Systemd Service

```ini
[Unit]
Description=SupaCloud Management API Server
After=network.target patroni.service
Wants=patroni.service

[Service]
Type=simple
EnvironmentFile=-/etc/supabase/management-api.env
ExecStartPre=/opt/supacloud/scripts/pre_start_recovery.sh
ExecStart=/usr/local/bin/supacloud
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### 6.2 Environment Variables

```bash
# /etc/supabase/management-api.env
PORT=9090
DATABASE_URL=postgresql://postgres:password@localhost:5432/supacloud_meta
MASTER_TOKEN=your-secure-master-token
SCRIPTS_PATH=/opt/supacloud/scripts/lib
```

---

## 7. Monitoring and Logging

### 7.1 Prometheus Metrics

All metrics have `project_ref` label:

```
supacloud_project_requests_total{project_ref="abc123"}
supacloud_project_db_connections{project_ref="abc123"}
supacloud_project_storage_bytes{project_ref="abc123"}
```

### 7.2 Log Format

```json
{
  "timestamp": "2025-01-29T12:00:00Z",
  "level": "info",
  "project_ref": "abc123",
  "message": "Project created successfully"
}
```

---

## 8. Error Handling and Rollback

### 8.1 Project Creation Flow

```
1. Generate project_ref
2. Insert into projects table (status: creating)
3. Create database → Rollback on failure
4. Create storage bucket → Rollback database on failure
5. Generate JWT keys
6. Configure Caddy routing
7. Update status: active
```

### 8.2 Rollback Strategy

- Database creation failed: Delete projects record only
- Storage creation failed: Delete database + projects record
- Routing config failed: Delete storage + database + projects record

---

## 9. Implementation Path

| Phase | Goal | Output |
|-------|------|--------|
| 1 | Basic API + Database layer | Runnable CRUD API |
| 2 | Shell script integration | Complete project creation flow |
| 3 | Caddy dynamic routing | Multi-tenant domain support |
| 4 | Monitoring integration | Grafana multi-project dashboard |
| 5 | CLI segmentation | Separate operator and project-user workflows |

---

## 10. CLI Segmentation

SupaCloud now splits human operators into two explicit command-line surfaces:

- `@supacloud/cli` / `supacloud-cli` for project-scoped workflows
- `@supacloud/admin` / `supacloud-admin` for installation, SSH, and platform operations

This keeps project deploy/log/database tasks separate from tenant lifecycle and server management.
