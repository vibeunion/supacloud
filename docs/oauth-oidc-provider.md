# OAuth 2.1 / OIDC Provider

SupaCloud tracks the newer Supabase Auth OAuth 2.1 Server / OIDC Provider model while keeping SupaCloud's project isolation model.

This feature is project-scoped. A project can become its own OAuth 2.1 authorization server and OIDC identity provider, but projects do not share issuer state, client registrations, signing keys, runtime state, or database state.

Upstream reference:

- [Supabase OAuth 2.1 Server](https://supabase.com/docs/guides/auth/oauth-server)
- [Supabase OAuth Server: Getting Started](https://supabase.com/docs/guides/auth/oauth-server/getting-started)
- [Supabase self-hosted Auth keys](https://supabase.com/docs/guides/self-hosting/self-hosted-auth-keys)

## Compatibility Contract

SupaCloud exposes Management API helpers for the Supabase-compatible public Auth endpoints:

| Capability | Public project endpoint |
|---|---|
| OIDC discovery | `/auth/v1/.well-known/openid-configuration` |
| OAuth authorization server metadata | `/.well-known/oauth-authorization-server/auth/v1` |
| JWKS | `/auth/v1/.well-known/jwks.json` |
| Authorization | `/auth/v1/oauth/authorize` |
| Token exchange | `/auth/v1/oauth/token` |
| UserInfo | `/auth/v1/oauth/userinfo` |
| Dynamic client registration | `/auth/v1/oauth/clients/register` |

The public OAuth flow stays on the project Auth endpoint. The Management API only manages project-scoped status, migration, and OAuth client CRUD.

## Direct Migration

This version does not keep an enable-only mode.

To migrate a project:

```bash
curl -X POST "$MANAGEMENT_API_URL/v1/projects/$PROJECT_REF/auth/oauth-server/migrate" \
  -H "Authorization: Bearer $MANAGEMENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "allow_dynamic_registration": true }'
```

Migration writes project-scoped Auth config:

- `auth.oauth_server.enabled = true`
- `auth.oauth_server.issuer = <project-api-url>/auth/v1`
- `auth.oauth_server.signing_alg = "ES256"`
- `auth.oauth_server.jwt_keys = [...]`
- `auth.oauth_server.jwt_jwks = { "keys": [...] }`
- `auth.oauth_server.migrated_at = <timestamp>`

SupaCloud uses ES256 for new OIDC signing keys to match the current Supabase Auth signing-key direction. The generated key material is project-scoped.

## Runtime Configuration

After migration, tenant runtime generation injects:

| Runtime | Config |
|---|---|
| GoTrue / Supabase Auth | `GOTRUE_OAUTH_SERVER_ENABLED=true`, `GOTRUE_OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION`, `GOTRUE_JWT_ISSUER`, `GOTRUE_JWT_KEYS` |
| PostgREST | `jwt-secret` set to the project `JWT_JWKS` JSON |
| Edge/runtime env | `JWT_KEYS`, `JWT_JWKS`, existing `JWT_SECRET` for compatibility |
| SupaCloud internal validators | Project JWKS first, legacy HS256 fallback when needed |

`JWT_KEYS` contains private signing material for Auth. `JWT_JWKS` contains public verification material for API components.

## Legacy API Key Compatibility

Migration keeps existing `anon` and `service_role` API keys usable.

The project JWKS includes legacy HS256 verification material so PostgREST, Storage, Realtime, SDK proxy, and Management API project-token checks can continue to verify existing API keys during and after migration.

This is not a shared-auth model:

- The legacy key material is still project-scoped.
- It does not let one project or account manage another project.
- It does not introduce a global issuer, global OAuth client table, or global runtime state.

## Management API

### Get OAuth Server Status

```bash
GET /v1/projects/:ref/auth/oauth-server
```

Example response:

```json
{
  "project_ref": "abcdefghijklmnopqrst",
  "organization_id": "org_123",
  "account_isolated": true,
  "enabled": true,
  "allow_dynamic_registration": true,
  "issuer": "https://abcdefghijklmnopqrst.api.example.com/auth/v1",
  "discovery_url": "https://abcdefghijklmnopqrst.api.example.com/auth/v1/.well-known/openid-configuration",
  "oauth_authorization_server_metadata_url": "https://abcdefghijklmnopqrst.api.example.com/.well-known/oauth-authorization-server/auth/v1",
  "jwks_url": "https://abcdefghijklmnopqrst.api.example.com/auth/v1/.well-known/jwks.json",
  "authorization_endpoint": "https://abcdefghijklmnopqrst.api.example.com/auth/v1/oauth/authorize",
  "token_endpoint": "https://abcdefghijklmnopqrst.api.example.com/auth/v1/oauth/token",
  "userinfo_endpoint": "https://abcdefghijklmnopqrst.api.example.com/auth/v1/oauth/userinfo",
  "registration_endpoint": "https://abcdefghijklmnopqrst.api.example.com/auth/v1/oauth/clients/register",
  "signing_alg": "ES256",
  "oidc_id_token_ready": true,
  "migration_status": "oidc_es256_migrated",
  "warnings": []
}
```

### Migrate Project

```bash
POST /v1/projects/:ref/auth/oauth-server/migrate
```

Body:

```json
{
  "allow_dynamic_registration": true
}
```

### OAuth Client CRUD

The Management API proxies project-scoped OAuth client administration to that project's GoTrue runtime:

| Method | Endpoint |
|---|---|
| `GET` | `/v1/projects/:ref/auth/oauth-clients` |
| `POST` | `/v1/projects/:ref/auth/oauth-clients` |
| `GET` | `/v1/projects/:ref/auth/oauth-clients/:clientId` |
| `PUT` | `/v1/projects/:ref/auth/oauth-clients/:clientId` |
| `DELETE` | `/v1/projects/:ref/auth/oauth-clients/:clientId` |
| `POST` | `/v1/projects/:ref/auth/oauth-clients/:clientId/regenerate-secret` |

All Management API routes require a valid Management API token or a project-scoped service-role token for the same `:ref`.

## `@supacloud/js`

```ts
const status = await client.auth.oauthServer.getStatus();

await client.auth.oauthServer.migrateToOidc({
  allowDynamicRegistration: true,
});

const discovery = await client.auth.oauthServer.getDiscovery();
const jwks = await client.auth.oauthServer.getJwks();

const authorizeUrl = await client.auth.oauthServer.buildAuthorizeUrl({
  clientId: "client_123",
  redirectUri: "https://app.example.com/callback",
  scope: ["openid", "email"],
  state: "opaque-state",
  codeChallenge: "pkce-challenge",
  codeChallengeMethod: "S256",
  nonce: "nonce",
});

const clients = await client.auth.oauthClients.list();
```

The SDK never accepts `accountId` or `organizationId` for authorization. It sends the same Bearer token as other Management API calls; the server decides project access.

## Isolation Rules

- Account/project ownership is a pre-existing control-plane boundary.
- OAuth/OIDC does not weaken that boundary.
- Cross-project application integration must use OAuth/OIDC authorization flows.
- Direct service-role, issuer, JWKS, OAuth client table, database, or runtime sharing is not allowed.
