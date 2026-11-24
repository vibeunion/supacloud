# Postrust v3.4.0 adoption

SupaCloud's project REST process is [Postrust v3.4.0](https://github.com/postrust/postrust/releases/tag/v3.4.0), MIT, Copyright 2024 Postrust Contributors. It replaces the PostgREST v16.6 binary and `postgrest/postgrest:v16.6` image. This is not a claim of bit-for-bit compatibility.

## Pin

| Item | Value |
| --- | --- |
| Release | https://github.com/postrust/postrust/releases/tag/v3.4.0 |
| Image | `docker.io/postrust/postrust:v3.4.0` |
| Index digest | `sha256:4de17b6c68403317a33c0a8ab78edb347e6b3131e9784c25b5c700554ac61809` |
| linux/amd64 manifest | `sha256:17ffc00f28a065bf228eaa74e6b823be0ae5813b4cf7b37a48f0067b9a464e2c` |
| Binary layer | `sha256:a2139f3563c558457f2b660bb92514a2b00d4d549392511fd127cd9669b5ef32` |
| Layer member | `usr/local/bin/postrust` |
| Binary SHA256 | `f174c84a1b3ac8a24c13a4ef7896adfc029ece8c1b206ee715e3864f5f169b7a` |

The GitHub release has no binary assets. The host installer downloads that layer from Docker Hub, checks both digests, and installs the binary at the existing `/usr/local/bin/postgrest` path so tenant units keep their executable path. v3.4.0's image index contains linux/amd64 only. An arm64 host fails the installer instead of falling back to PostgREST.

The official image is built with `admin-ui,otel`, not `compat-key-order`.

## Compatibility mode

Postrust's default REST prefix is `/api`, and its default RPC body is wrapped. Every supported launch path sets `PGRST_COMPAT_MODE=true`:

- Compose and the CI service set it in the environment.
- The Podman quadlet sets it beside the env file.
- The tenant launcher clears the process environment and rebuilds it from the trusted per-tenant `.conf`. It always appends `PGRST_COMPAT_MODE=true`. Haskell `+RTS` arguments from older units are dropped.

The launcher maps the existing keys (`db-uri`, `db-schemas`, `db-anon-role`, `jwt-secret`, `db-pre-request`, `db-channel`, and the other keys the management API already writes) onto Postrust's `PGRST_*` variables. When `db-channel` is set and `db-channel-enabled` is not, it sets `PGRST_DB_CHANNEL_ENABLED=true`, which matches PostgREST's default LISTEN behavior. Unknown keys fail closed.

## What stays the same

- Authorization remains GRANT plus RLS. The connection user stays the per-project `authenticator_*` role, and Postrust runs `SET LOCAL ROLE` from the JWT `role` claim. `anon`, `authenticated`, and `service_role` are unchanged. `supabase_auth_admin` and `supabase_admin` are unchanged.
- GoTrue still issues the JWT. `auth.uid()` still reads `request.jwt.claim.sub` and falls back to `request.jwt.claims`. `db-pre-request = "public.set_request_context"` is still passed through.
- Project GraphQL remains `/graphql/v1` proxied to `pg_graphql` through `/rpc/graphql`. Postrust's Hasura-dialect routes are not added to the public gateway.
- Isolation remains one database per project.

## Known gaps

Postrust's own [conformance note](https://github.com/postrust/postrust/blob/v3.4.0/docs/postgrest-conformance.md) says that, on the compatibility build against PostgREST's suite, status codes agree and full-contract agreement is short of every case. This repository did not run that live suite. Do not treat the pin as a passing conformance result.

These differences remain with the official image and compatibility mode:

- OpenAPI is not PostgREST's Swagger 2.0 document at `/`. Postrust serves its own OpenAPI 3.0 description, and object keys stay alphabetical unless the binary is rebuilt with `compat-key-order`. The published image is not built that way.
- `Prefer: tx=rollback` is not implemented.
- The REST process also answers Postrust GraphQL at `/api/graphql` and `/v1/graphql`. That is a second implementation on the internal port. Public project GraphQL is still pg_graphql. Do not route clients to Postrust's GraphQL paths.
- There is no official linux/arm64 artifact for v3.4.0.

No production host was upgraded, retagged, or deployed for this pin.
