# Project endpoint projection

SupaCloud exposes one credential-free, authoritative projection of each project's public API, Auth/OIDC, and Studio origins. Consumers must use this projection instead of reconstructing domains from a project ref or a platform base domain.

## Management API

Selected-project read:

```http
GET /v1/projects/:ref/endpoint/projection
```

This route accepts the selected project's Management API credential or an Admin credential.

Platform inventory:

```http
GET /v1/projects/endpoints
```

The inventory route is Admin-only. It does not widen project-scoped credentials or return project secrets.

A projection has the fixed schema:

```json
{
  "schema": "supacloud.project-endpoints.v1",
  "project_ref": "abc123",
  "endpoints": {
    "api": {
      "origin": "https://api.example.com",
      "host": "api.example.com",
      "scheme": "https",
      "source": "explicit_api_domain",
      "aliases": ["abc123.api.platform.example"]
    },
    "auth": {
      "origin": "https://auth.example.com",
      "host": "auth.example.com",
      "scheme": "https",
      "source": "explicit_auth_domain",
      "aliases": []
    },
    "studio": {
      "origin": "https://studio.example.com",
      "host": "studio.example.com",
      "scheme": "https",
      "source": "explicit_studio_domain",
      "aliases": []
    }
  }
}
```

The allowed `source` values are:

- `explicit_api_domain`
- `explicit_auth_domain`
- `explicit_studio_domain`
- `custom_domain`
- `derived_api_domain`
- `generated`

The projection reuses the same routing resolver that builds tenant gateway configuration. It canonicalizes origins and aliases and never includes credentials, paths, query strings, fragments, project config, API keys, or runtime receipts.

## CLI commands

Selected project:

```bash
supacloud-cli project endpoints --ref abc123
```

`--ref` may be omitted when the selected Management profile already binds one project.

Admin reads:

```bash
supacloud-admin project endpoints --ref abc123
supacloud-admin project list_endpoints
```

`supacloud-cli project list` deliberately does not enumerate the fleet. It returns guidance to use `supacloud-admin project list`, preserving the project/Admin credential boundary.

## What the projection proves

The projection proves how SupaCloud currently resolves the configured public origins. It does **not** prove that:

- DNS resolves to the intended gateway;
- a certificate has been issued or deployed;
- Caddy has published the route;
- API, Auth, or Studio is healthy;
- a custom hostname verification challenge has completed.

Use project health, gateway route, custom-hostname, and certificate inspection commands before reporting readiness.

## Compatibility

The existing Studio-compatible endpoint remains unchanged:

```http
GET /v1/projects/:ref/endpoint
```

The new projection uses a separate path and fixed response schema so existing integrations are not forced to accept additional fields. Release Please owns package version and changelog updates; feature commits must not manually bump package versions.
