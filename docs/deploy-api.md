# SupaCloud Deploy API Reference

## Overview

SupaCloud Deploy API provides configuration-driven automated deployment with zero-downtime switching.

## Endpoints

### POST /api/v1/deploy

Deploy an application.

**Request Body:**

```json
{
  "app": "string",
  "tenant": "string",
  "artifact": "string (base64 encoded tarball)",
  "config": {
    "app": "string",
    "tenant": "string",
    "static": [...],
    "ssr": [...],
    "hooks": {...},
    "retention": {...}
  }
}
```

**Response:**

```json
{
  "success": true,
  "deploymentId": "1709827200000_abc123def",
  "versions": {
    "current": "20240307_120000",
    "previous": "20240306_100000"
  },
  "urls": ["https://example.com/admin/"],
  "rollbackCommand": "curl -X POST .../deploy/rollback -d '{\"app\":\"my-app\",\"version\":\"20240306_100000\"}'",
  "logs": [
    "[2024-03-07T12:00:00.000Z] Starting deployment for app: my-app",
    "[2024-03-07T12:00:01.000Z] Artifact saved to temp directory",
    "[2024-03-07T12:00:02.000Z] Artifact extracted",
    "[2024-03-07T12:00:03.000Z] Deploying static app: admin",
    "[2024-03-07T12:00:04.000Z] Symlink updated",
    "[2024-03-07T12:00:05.000Z] Deployment completed successfully"
  ]
}
```

### POST /api/v1/deploy/rollback

Rollback to a specific version.

**Request Body:**

```json
{
  "app": "string (required)",
  "version": "string (optional, defaults to previous version)"
}
```

**Response:**

```json
{
  "success": true,
  "deploymentId": "rollback_1709827800000_xyz789",
  "versions": {
    "current": "20240306_100000",
    "previous": null
  },
  "urls": [],
  "rollbackCommand": "",
  "logs": [
    "[2024-03-07T12:10:00.000Z] Starting rollback for app: my-app",
    "[2024-03-07T12:10:01.000Z] Rolling back to version: 20240306_100000",
    "[2024-03-07T12:10:02.000Z] Symlink updated",
    "[2024-03-07T12:10:03.000Z] Service my-service restarted"
  ]
}
```

### GET /api/v1/deploy/history

Get deployment history.

**Query Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `app` | string | No | - | Filter by app name |
| `limit` | number | No | 20 | Number of records to return |

**Response:**

```json
{
  "success": true,
  "history": [
    {
      "id": "1709827200000_abc123def",
      "appId": "my-app",
      "tenant": "my-tenant",
      "version": "20240307_120000",
      "status": "success",
      "deployedAt": "2024-03-07T12:00:00.000Z",
      "triggeredBy": "github-actions"
    },
    {
      "id": "1709740800000_def456ghi",
      "appId": "my-app",
      "tenant": "my-tenant",
      "version": "20240306_100000",
      "status": "success",
      "deployedAt": "2024-03-06T10:00:00.000Z",
      "triggeredBy": "api"
    }
  ]
}
```

### GET /api/v1/deploy/versions

Get available versions for an app.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `app` | string | Yes | App name |

**Response:**

```json
{
  "success": true,
  "app": "my-app",
  "versions": [
    {
      "version": "20240307_120000",
      "deployedAt": "2024-03-07T12:00:00.000Z",
      "status": "success"
    },
    {
      "version": "20240306_100000",
      "deployedAt": "2024-03-06T10:00:00.000Z",
      "status": "success"
    }
  ]
}
```

## Configuration Schema

### Root Configuration

```yaml
app:
  name: string    # Application name (required)
  tenant: string  # Tenant ID (required)

deploy:
  static: [...]   # Static site configurations
  ssr: [...]      # SSR service configurations
  hooks: {...}    # Deployment hooks
  retention: {...} # Version retention policy
```

### Static Site Configuration

```yaml
deploy:
  static:
    - name: string      # Site name (required)
      source: string    # Build artifact path (required)
      target: string    # Target symlink path (required)
      url: string       # Access URL (optional)
```

### SSR Service Configuration

```yaml
deploy:
  ssr:
    - name: string       # Service name (required)
      source: string     # Build artifact path (required)
      target: string     # Target symlink path (required)
      service: string    # systemd service name (required)
      url: string        # Access URL (optional)
      env:               # Environment variables (optional)
        KEY: value
```

### Hooks Configuration

```yaml
deploy:
  hooks:
    pre_deploy: string   # Command to run before deployment
    post_deploy: string  # Command to run after successful deployment
    on_failure: string   # Command to run on deployment failure
```

### Retention Configuration

```yaml
deploy:
  retention:
    keep_versions: number  # Number of versions to keep (default: 5)
    auto_cleanup: boolean  # Auto cleanup old versions (default: true)
```

## Error Responses

### 400 Bad Request

```json
{
  "success": false,
  "error": "Missing required fields: app, tenant, artifact, config"
}
```

### 500 Internal Server Error

```json
{
  "success": false,
  "error": "Deployment failed: disk space insufficient"
}
```

## TypeScript Types

```typescript
interface DeployRequest {
  app: string;
  tenant: string;
  artifact: string;
  config: DeployConfig;
}

interface DeployConfig {
  app: string;
  tenant: string;
  static?: StaticDeployConfig[];
  ssr?: SSRDeployConfig[];
  hooks?: HooksConfig;
  retention?: RetentionConfig;
}

interface StaticDeployConfig {
  name: string;
  source: string;
  target: string;
  url?: string;
}

interface SSRDeployConfig {
  name: string;
  source: string;
  target: string;
  service: string;
  url?: string;
  env?: Record<string, string>;
}

interface HooksConfig {
  pre_deploy?: string;
  post_deploy?: string;
  on_failure?: string;
}

interface RetentionConfig {
  keep_versions?: number;
  auto_cleanup?: boolean;
}

interface DeployResult {
  success: boolean;
  deploymentId: string;
  versions: {
    current: string;
    previous: string | null;
  };
  urls: string[];
  rollbackCommand: string;
  logs: string[];
}

interface DeploymentHistory {
  id: string;
  appId: string;
  tenant: string;
  version: string;
  status: 'success' | 'failed' | 'rolled_back';
  deployedAt: Date;
  triggeredBy: string;
  config: DeployConfig;
}
```

## See Also

- [Deploy Guide](./deploy-guide.md) - Detailed usage guide
- [Configuration Example](./supacloud.yml.example) - Example configuration file
