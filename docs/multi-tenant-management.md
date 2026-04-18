# SupaCloud Multi-tenant Management Solution and Management API Technical Specification

This document details the technical solution design for multi-project management based on Pigsty architecture and the complete technical specification for Management API.

---

## 1. Architecture Overview

Multiple Supabase projects are run with logical isolation by sharing infrastructure (Pigsty PostgreSQL, Nginx gateway, and S3 storage).

```
┌─────────────────────────────────────────────────────────────┐
│                    Management API (:9090)                    │
│              Bun + Elysia + Dependency Injection             │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ JwtService   │  │ DbService    │  │ S3Service    │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
│         │                 │                 │                │
│         ▼                 ▼                 ▼                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │jwt_manager.sh│  │db_manager.sh │  │s3_manager.sh │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                    Shared Infrastructure                     │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐             │
│  │ PostgreSQL │  │   Nginx    │  │  S3 Storage│             │
│  │  (Pigsty)  │  │  (ACME)    │  │(RustFS/etc)│             │
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

### 2.3 Storage Isolation (S3)

- **Bucket Naming**: `supa-<project_ref>`
- **Credentials**: Independent Access Key / Secret Key per project
- **Supported Backends**: RustFS, Garage, MinIO, External S3

### 2.4 DNS and Routing Isolation

Dynamic Vhost generation, Management API generates config snippets in `/etc/nginx/sites-enabled/supa-tenants/`.

| Domain Pattern | Routing Target |
|----------------|----------------|
| `api.example.com` | Shared Kong Gateway |
| `studio.example.com` | Shared Studio Console |
| `<project>.api.example.com` | Kong + Tenant Header |

---

## 3. JWT Security Isolation

### 3.1 Independent Keys

Each project generates a unique `JWT_SECRET` (32+ characters) during initialization.

### 3.2 Key Derivation

```
JWT_SECRET → ANON_KEY (role: anon, exp: 10 years)
JWT_SECRET → SERVICE_ROLE_KEY (role: service_role, exp: 10 years)
```

### 3.3 Kong Integration

Kong dynamically validates JWT keys for different projects based on `Host` Header.

---

## 4. Management API Specification

### 4.1 Authentication

- **Master Token**: Stored in `/etc/supabase/master-token.env`
- **Header**: `Authorization: Bearer <MASTER_TOKEN>`

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
| GET | `/v1/projects/:ref/status` | Get project running status |
| POST | `/v1/projects/:ref/restart` | Restart project services |
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
├── s3_manager.sh      # Storage management
├── router_manager.sh  # Nginx routing management
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

#### s3_manager.sh

```bash
# Create project Bucket
s3_manager.sh create <project_ref>

# Delete project Bucket
s3_manager.sh delete <project_ref>

# Get credentials
s3_manager.sh credentials <project_ref>
```

#### router_manager.sh

```bash
# Add project route
router_manager.sh add <project_ref> <domain>

# Remove project route
router_manager.sh remove <project_ref>

# Reload Nginx
router_manager.sh reload
```

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
EnvironmentFile=-/opt/supacloud/config.env
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
4. Create S3 Bucket → Rollback database on failure
5. Generate JWT keys
6. Configure Nginx routing
7. Update status: active
```

### 8.2 Rollback Strategy

- Database creation failed: Delete projects record only
- S3 creation failed: Delete database + projects record
- Routing config failed: Delete S3 + database + projects record

---

## 9. Implementation Path

| Phase | Goal | Output |
|-------|------|--------|
| 1 | Basic API + Database layer | Runnable CRUD API |
| 2 | Shell script integration | Complete project creation flow |
| 3 | Nginx dynamic routing | Multi-tenant domain support |
| 4 | Monitoring integration | Grafana multi-project dashboard |
| 5 | MCP Server | AI Agent native infrastructure control |

---

## 10. MCP Server (AI Agent Integration)

### 10.1 Architecture Design

MCP Server runs as an **npm package** locally on user's machine (Cursor / Claude Desktop), connecting to target server via two channels:

```
User's Machine (AI IDE)
┌───────────────────────────────┐
│  @supacloud/mcp-server (stdio)│
│  ┌──────────┐  ┌────────────┐│
│  │ SSH Channel│  │ HTTP Channel││
│  └────┬─────┘  └─────┬──────┘│
└───────┼──────────────┼───────┘
        │              │
   ═════╪══════════════╪═════ Network
        │              │
┌───────▼──────────────▼───────┐
│         Target Server          │
│  Port 22 (SSH)  Port 9090 (API)│
│  install.sh     Management API │
└──────────────────────────────┘
```

### 10.2 Two-Phase Tool Model

| Phase | SupaCloud Status | Transport Channel | Available Tools |
|-------|------------------|-------------------|-----------------|
| Pre-installation | Not installed | SSH | `ping_server` `install_supacloud` `upgrade_supacloud` `diagnose_server` `ssh_exec` |
| Post-installation | Running | HTTP API | Project CRUD, function deployment, Auth config, Secrets, backup, monitoring, etc. 23 tools |

### 10.3 Configuration

```json
{
  "mcpServers": {
    "supacloud": {
      "command": "npx",
      "args": ["-y", "@supacloud/mcp-server"],
      "env": {
        "SUPACLOUD_HOST": "Server IP",
        "SUPACLOUD_SSH_KEY": "~/.ssh/id_rsa",
        "SUPACLOUD_API_TOKEN": "Master Token (fill in after installation)"
      }
    }
  }
}
```

### 10.4 Security Policy

- SSH key/password injected via environment variables, not persisted
- API Token matches Management API's Master Token
- Tool-level permission separation: SSH tools and HTTP tools registered independently based on environment variables
- Sensitive operations (`ssh_exec`, `delete_project`) marked with risk in tool description

