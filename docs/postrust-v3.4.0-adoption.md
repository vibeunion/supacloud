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

Shared Compose, Podman, CI, and pilot containers have no per-tenant config file. They set `PGRST_DB_CHANNEL=pgrst` and `PGRST_DB_CHANNEL_ENABLED=true` so a `NOTIFY pgrst` from the existing DDL trigger reloads the schema cache. Postrust leaves that listener off unless it is set.

supabase-js bulk insert sends `columns="task","is_complete"`. Postrust treats the quote characters as part of the column name. The public Caddy `/rest/v1*` route rewrites that parameter before it strips the prefix, and the project REST proxy applies the same translation. A client that opens the loopback REST port directly still needs unquoted `columns`.

## What stays the same

- Authorization remains GRANT plus RLS. The connection user stays the per-project `authenticator_*` role, and Postrust runs `SET LOCAL ROLE` from the JWT `role` claim. `anon`, `authenticated`, and `service_role` are unchanged. `supabase_auth_admin` and `supabase_admin` are unchanged.
- GoTrue still issues the JWT. `auth.uid()` still reads `request.jwt.claim.sub` and falls back to `request.jwt.claims`. `db-pre-request = "public.set_request_context"` is still passed through.
- Project GraphQL remains `/graphql/v1` proxied to `pg_graphql` through `/rpc/graphql`. Postrust's Hasura-dialect routes are not added to the public gateway.
- Isolation remains one database per project.

## SDK parity evidence

CI on `363bc7eff` (`run 45408359105`) failed `from().select().order()` in `sdk-parity.test.ts`. The assertion expected two rows from `.like("task", "order-%-<run>")` and received none. The same assertion passes on `main` with PostgREST v16.6.

The rows were never inserted. supabase-js bulk insert sends `columns="task","is_complete"`. Postrust v3.4.0 `parse_columns` keeps the quote characters, so the names do not match the table and the insert is rejected. The test ignored that error and then counted zero rows. `like` itself still passes `%` through to SQL `LIKE` after replacing only `*` with `%` (`crates/postrust-core/src/query/builder.rs` at tag v3.4.0), so a percent pattern remains a wildcard once the rows exist.

The public Caddy `/rest/v1*` route and the project REST proxy each strip one pair of surrounding quotes per name before the request reaches Postrust. `tests/unit/postrust-columns-param.test.ts` pins both translations. A client that opens the loopback REST port directly still has to send unquoted `columns`.

## Surfaces the official image always serves

The CI container log for the pinned image records this startup, and v3.4.0 has no environment variable that removes it:

- `/admin`, `/admin/openapi.json`, `/admin/swagger`, `/admin/scalar`, and `/admin/graphql` come from the `admin-ui` build feature. The dashboard and OpenAPI handlers in `crates/postrust-server/src/admin.rs` take no credential. A client that can open the listener directly can still open them.
- `/_` is the custom-route and health surface (`/_/health`).
- `/api/graphql` and GraphQL subscriptions start even when `PGRST_GRAPHQL_FEDERATION` is left false. That flag only adds Apollo Federation fields. The subscription broker then retries DNS for its notification listener, which is a new log and CPU source on a host that has no such name.

The public gateway still forwards project GraphQL to `pg_graphql` at `/graphql/v1` → `/rpc/graphql`. A request under `/rest/v1` whose path, after the prefix strip, is `/admin` (including `/admin/openapi.json`, `/swagger`, `/scalar`, and `/graphql`), `/_`, `/api/graphql`, `/v1/graphql`, or `/v1alpha1/graphql` is answered with 404 before that strip. The project REST proxy refuses the same suffixes. v3.4.0 cannot turn the handlers off without a different build, and this repository does not ship a fork of the image.

The host tenant process binds `127.0.0.1`. Caddy on that host dials `127.0.0.1`, which is also where the Management API proxy and health checks connect. Compose and Podman do not publish the container port; the image still listens on `0.0.0.0` inside its own network namespace so the gateway container can reach it. The CI service publishes `127.0.0.1:3000` only.

## Other deviations from PostgREST v16.6

- **arm64.** `install.sh` still installs arm64 artifacts for other components. Postrust v3.4.0 publishes no linux/arm64 image or release binary. The REST installer fails closed on that architecture instead of leaving PostgREST in place.
- **CORS.** An empty `PGRST_SERVER_CORS_ORIGINS`, which is the default, allows every origin and sends `Access-Control-Allow-Origin` accordingly. PostgREST sends no CORS headers unless `server-cors-allowed-origins` is set. The per-tenant `.conf` still sets that key and the launcher maps it. Compose, Podman, CI, and the pilot do not, so those processes are more permissive than PostgREST was. There is no documented value that restores "send no CORS headers."
- **Object key order and `GET /`.** The official image logs that compatibility mode still returns object keys alphabetically. `GET /` is not PostgREST's Swagger 2.0 document. Both are visible to anything that reads the REST port directly.
- **Unknown `.conf` keys.** The launcher exits if a key is not in the mapped set. The management API writer only emits mapped keys, so the generated file starts. An operator-added PostgREST setting that this mapping does not know makes the tenant REST process fail at restart. There is no fallback to the PostgREST binary.
- **`Prefer: tx=rollback`** is not implemented.

## Conformance

Upstream [postgrest-conformance.md](https://github.com/postrust/postrust/blob/v3.4.0/docs/postgrest-conformance.md) at v3.4.0 reports 99.1% full-contract agreement over 1499 replayed PostgREST cases, and says that measurement used a binary built with `admin-ui,compat-key-order`. The image pinned here is the published `admin-ui,otel` build, which does not include `compat-key-order`. This repository has not replayed that suite. A passing compile of this pin is not that result.

`docs/adr/2026-11-24-postgrest-dataplane-unification.md` describes the data-plane direction. It is not a test result for this image and it does not authorize a production cutover.

No production host was upgraded, retagged, or deployed for this pin.
