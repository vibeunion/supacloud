# Postrust v3.4.0 adoption

SupaCloud's project REST process is [Postrust v3.4.0](https://github.com/postrust/postrust/releases/tag/v3.4.0), MIT, Copyright 2024 Postrust Contributors. It replaces the PostgREST v16.6 binary and `postgrest/postgrest:v16.6` image. This is not a claim of bit-for-bit compatibility.

## Pin

The upstream release stays [Postrust v3.4.0](https://github.com/postrust/postrust/releases/tag/v3.4.0). SupaCloud does not install that release's official image. Two patched artifacts are in use, and they are not the same binary.

### Host installer and tenant runtime default

The host installer and tenant runtime default to the published temporary layer `v3.4.0+supacloud.1`. That layer is built from the pinned v3.4.0 source plus [`docs/patches/postrust-v3.4.0-temporary-fixes.patch`](./patches/postrust-v3.4.0-temporary-fixes.patch), which carries both the null-RPC fix and the GraphQL type-name fix. The installer downloads the existing release asset and verifies the layer SHA-256 and the binary SHA-256 before it installs the member at `/usr/local/bin/postrust`.

| Item | Value |
| --- | --- |
| Version | `v3.4.0+supacloud.1` |
| Release | https://github.com/vibeunion/supacloud/releases/tag/postrust-v3.4.0-supacloud.1 |
| Layer asset | `postrust-v3.4.0-supacloud.1-linux-amd64.tar.gz` |
| Layer SHA256 | `e9e721400159b4e2cce78a860b2989cb67b3eb3628a232a57a0bd8a0072be79e` |
| Layer member | `usr/local/bin/postrust` |
| Binary SHA256 | `647e3f3d649f96adca20db8d8b774167d8b4129d186dfa76839e6ed8866c457e` |
| Patch | `docs/patches/postrust-v3.4.0-temporary-fixes.patch` |
| Rebuild | `scripts/build_postrust_temporary_fixes.sh` and `.github/workflows/postrust-temporary-fixes.yml` |
| Rebuild Rustc | 1.94.1 |

`POSTGREST_SHA256`, `POSTRUST_BINARY_SHA256`, and `POSTRUST_RELEASE_URL` do not replace this pin. The layer is linux/amd64 only. An arm64 host does not install it by default.

The version stamp `/usr/local/bin/postrust.postrust-version` lists `v3.4.0+supacloud.1` and the binary SHA-256 above. Tenant start accepts that version only when an ELF at the path has that digest. The official unpatched digest is a different file, so it does not satisfy this check.

### Explicit `POSTGREST_VERSION=v3.4.0`, Compose, Podman, and CI

`POSTGREST_VERSION=v3.4.0` keeps the source-build path. It builds `postrust-server` from the tag archive and applies [`docs/patches/postrust-v3.4.0-null-rpc-args.patch`](./patches/postrust-v3.4.0-null-rpc-args.patch) before `cargo build --release --locked`. It does not download or install the official image, and it refuses a binary whose SHA-256 is the unpatched official member. This path does not apply the GraphQL type-name patch.

Compose files, the Podman quadlet, and CI use this same source-build. They are not switched to the temporary layer, and they are not switched back to the official image.

| Item | Value |
| --- | --- |
| Release | https://github.com/postrust/postrust/releases/tag/v3.4.0 |
| Source archive | https://github.com/postrust/postrust/archive/refs/tags/v3.4.0.tar.gz |
| Source SHA256 | `2c5de117fe288a18046776dfd0505d21845ba49b072d62bdab2c29ce3f2fe722` |
| Patch | `docs/patches/postrust-v3.4.0-null-rpc-args.patch` |
| Patch id | `postrust-v3.4.0-null-rpc-args` |
| Patch SHA256 | `b6fc50a592ede5071484e5e83a5ad1b59134724dcd2d91f71bf60b5b8bc983a6` |
| Rustc | 1.98.1 (`rust:1.98.1-bookworm`, the toolchain in upstream's Dockerfile) |
| Package and features | `postrust-server` with `admin-ui,otel` |
| Build script | `scripts/build_supacloud_postrust.sh` |
| Image | `docker/self-host/postrust/Dockerfile`, tagged `supacloud-postrust:3.4.0-null-rpc` |
| Podman tag | `localhost/supacloud-postrust:local` |

The source build runs on the host architecture. linux/amd64 uses Rust dist SHA256 `24ba1338a2d35c5a3247936546429e163fa674d726102af18bdf624582c57aea`. linux/arm64 uses `f00ba576645cef658e1deed96fab8f707958e9d58808b16343448b5d1c4f7407`. Rustc 1.98.1 stays the pin for this path. The temporary-layer rebuild stays on Rust 1.94.1 so the published layer and binary digests remain reproducible. The two toolchains coexist.

The built binary's SHA256 depends on the compiler output. It is recorded next to the installed binary and is not pinned as a second upstream digest. The official image remains identifiable so a drop-in of that binary is refused:

| Official artifact, not installed | Value |
| --- | --- |
| Image | `docker.io/postrust/postrust:v3.4.0` |
| Index digest | `sha256:4de17b6c68403317a33c0a8ab78edb347e6b3131e9784c25b5c700554ac61809` |
| linux/amd64 manifest | `sha256:17ffc00f28a065bf228eaa74e6b823be0ae5813b4cf7b37a48f0067b9a464e2c` |
| Binary layer | `sha256:a2139f3563c558457f2b660bb92514a2b00d4d549392511fd127cd9669b5ef32` |
| Layer member | `usr/local/bin/postrust` |
| Unpatched binary SHA256 | `f174c84a1b3ac8a24c13a4ef7896adfc029ece8c1b206ee715e3864f5f169b7a` |

## How to see which artifact is installed

- Host default: `/usr/local/bin/postgrest.postrust-version` lists `v3.4.0+supacloud.1` and `647e3f3d649f96adca20db8d8b774167d8b4129d186dfa76839e6ed8866c457e`. That install has no null-RPC source-build stamp. The installer has already checked the layer digest `e9e721400159b4e2cce78a860b2989cb67b3eb3628a232a57a0bd8a0072be79e`.
- Explicit `v3.4.0` source build, Compose, Podman, and CI: `/usr/local/bin/postrust.postrust-patch` (or `/usr/local/lib/supacloud/postrust-patch` in the image) lists the patch id `postrust-v3.4.0-null-rpc-args`, patch SHA256, source SHA256, rustc `1.98.1`, and features `admin-ui,otel`. The image label is `org.supacloud.postrust.patch=postrust-v3.4.0-null-rpc-args`. `/usr/local/lib/supacloud/SHA256SUMS.postrust` is the built binary. A file whose SHA256 is `f174c84a1b3ac8a24c13a4ef7896adfc029ece8c1b206ee715e3864f5f169b7a` is refused.

Both patched builds use the same features as the official image: `admin-ui,otel`, not `compat-key-order`.

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
- Project GraphQL is `/graphql/v1` rewritten to Postrust `/v1/graphql` on the loopback REST port. The public gateway does not publish Postrust's `/api/graphql`, `/v1/graphql`, or `/v1alpha1/graphql` as client paths. See [Postrust GraphQL](./postrust-graphql-evaluation.md).
- Isolation remains one database per project.

## SDK parity evidence

CI on `363bc7eff` (`run 45408359105`) failed `from().select().order()` in `sdk-parity.test.ts`. The assertion expected two rows from `.like("task", "order-%-<run>")` and received none. The same assertion passes on `main` with PostgREST v16.6.

The rows were never inserted. supabase-js bulk insert sends `columns="task","is_complete"`. Postrust v3.4.0 `parse_columns` keeps the quote characters, so the names do not match the table and the insert is rejected. The test ignored that error and then counted zero rows. `like` itself still passes `%` through to SQL `LIKE` after replacing only `*` with `%` (`crates/postrust-core/src/query/builder.rs` at tag v3.4.0), so a percent pattern remains a wildcard once the rows exist.

The public Caddy `/rest/v1*` route and the project REST proxy each strip one pair of surrounding quotes per name before the request reaches Postrust. `tests/unit/postrust-columns-param.test.ts` pins both translations. A client that opens the loopback REST port directly still has to send unquoted `columns`.

## Surfaces the admin-ui build always serves

The default build keeps the `admin-ui,otel` features. v3.4.0 has no environment variable that removes these routes:

- `/admin`, `/admin/openapi.json`, `/admin/swagger`, `/admin/scalar`, and `/admin/graphql` come from the `admin-ui` build feature. The dashboard and OpenAPI handlers in `crates/postrust-server/src/admin.rs` take no credential. A client that can open the listener directly can still open them.
- `/_` is the custom-route and health surface (`/_/health`).
- `/api/graphql` and GraphQL subscriptions start even when `PGRST_GRAPHQL_FEDERATION` is left false. That flag only adds Apollo Federation fields. The subscription broker then retries DNS for its notification listener, which is a new log and CPU source on a host that has no such name.

Public `/graphql/v1` rewrites to `/v1/graphql` on that loopback port. A request under `/rest/v1` whose path, after the prefix strip, is `/admin` (including `/admin/openapi.json`, `/swagger`, `/scalar`, and `/graphql`), `/_`, `/api/graphql`, `/v1/graphql`, or `/v1alpha1/graphql` is answered with 404 before that strip. The project REST proxy refuses the same suffixes. The default build keeps `admin-ui,otel`, so v3.4.0 still cannot turn those handlers off. The null-RPC patch does not remove them. The rewrite and the remaining gaps are described in [Postrust GraphQL](./postrust-graphql-evaluation.md).

The host tenant process binds `127.0.0.1`. Caddy on that host dials `127.0.0.1`, which is also where the Management API proxy and health checks connect. Compose and Podman do not publish the container port; the image still listens on `0.0.0.0` inside its own network namespace so the gateway container can reach it. CI starts the patched binary on `127.0.0.1:3000` only.

## Other deviations from PostgREST v16.6

- **arm64.** `install.sh` still installs arm64 artifacts for other components. Postrust v3.4.0 publishes no linux/arm64 image or release binary, and the temporary layer is linux/amd64 only, so the default host installer does not install it on arm64. `POSTGREST_VERSION=v3.4.0` still builds the null-RPC source with the pinned arm64 Rust toolchain. Compose, Podman, and CI keep that source-build. Downloading the official image still fails on arm64, and that image is not installed.
- **CORS.** An empty `PGRST_SERVER_CORS_ORIGINS`, which is the default, allows every origin and sends `Access-Control-Allow-Origin` accordingly. PostgREST sends no CORS headers unless `server-cors-allowed-origins` is set. The per-tenant `.conf` still sets that key and the launcher maps it. Compose, Podman, CI, and the pilot do not, so those processes are more permissive than PostgREST was. There is no documented value that restores "send no CORS headers."
- **Object key order and `GET /`.** The official image logs that compatibility mode still returns object keys alphabetically. `GET /` is not PostgREST's Swagger 2.0 document. Both are visible to anything that reads the REST port directly.
- **Unknown `.conf` keys.** The launcher exits if a key is not in the mapped set. The management API writer only emits mapped keys, so the generated file starts. An operator-added PostgREST setting that this mapping does not know makes the tenant REST process fail at restart. There is no fallback to the PostgREST binary.
- **`Prefer: tx=rollback`** is not implemented.

## JSON null RPC arguments

The official unpatched v3.4.0 binary does not preserve JSON `null` in a named RPC
argument. `crates/postrust-core/src/plan/call_plan.rs` maps
`serde_json::Value::Null` to `String::new()` and binds the empty string. A
function taking a nullable `uuid`, `timestamptz`, or any other type that cannot
parse `''` fails with PostgreSQL `22P02`:

```text
invalid input syntax for type uuid: ""
```

A request that PostgREST accepts therefore fails on Postrust:

```sh
curl -sS -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  --data '{"p_actor_user_id":"...","p_actor_membership_id":"...",
           "p_cursor_timestamp":null,"p_cursor_id":null,
           "p_limit":50,"p_view":"all"}' \
  "https://$PROJECT_DOMAIN/rest/v1/rpc/fa_actor_notification_view_page"
```

The measured PostgreSQL bind parameters were `$3 = ''` and `$4 = ''`. Passing
non-null cursor values returns 200, which makes this easy to miss in a smoke
test. It breaks optional cursor arguments, notification pages, and scheduled
workers that call such RPCs.

A source patch that represents the value as `Option<String>` and renders
`NULL::<declared type>` is in
[`docs/patches/postrust-v3.4.0-null-rpc-args.patch`](./patches/postrust-v3.4.0-null-rpc-args.patch).
The host default and the explicit `v3.4.0` source build both apply this fix. The temporary layer includes it inside `docs/patches/postrust-v3.4.0-temporary-fixes.patch`. The source build applies `docs/patches/postrust-v3.4.0-null-rpc-args.patch` alone. An earlier local rebuild of the pinned `postrust-server` features produced one linux/amd64 binary with SHA-256 `136ba4f400be8b06179a7e9e89060b3a52b640778e9c8854b86ec2a05738ca54`. A later linux/amd64 release build with rustc 1.98.1 and the null-RPC patch produced `c53a85b3c60cc9329ad8603ea6047e2ac7210da07314804ecd43d36dfd78b2aa`. Neither digest is the checksum the temporary layer pins, and neither is a checksum the source-build installer requires. The source-build installer checks the source archive, the patch, and the stamp, then records the SHA256 of the binary it just built. The temporary installer checks the published layer and binary digests.

The official binary SHA-256 `f174c84a1b3ac8a24c13a4ef7896adfc029ece8c1b206ee715e3864f5f169b7a` still has the defect. The default installer, the `POSTGREST_VERSION=v3.4.0` source build, Compose, Podman, and CI refuse that file. Do not replace either patched artifact with the official v3.4.0 image while any application passes `null` to a named RPC argument. The upstream pin stays v3.4.0. This is not a production host upgrade.

## Blocking defect: GraphQL type names

The official v3.4.0 binary also exposes a PostgreSQL type name that GraphQL cannot name. `pg_type_to_graphql` falls through to `GraphQLType::Custom(format_type(...))`, and `format_type` schema-qualifies a type that is outside the connection's search path. A GraphQL name may only match `[_A-Za-z][_0-9A-Za-z]*`, so a project with a function that takes a table row type produces introspection that no generated client can load.

A source patch is in [`docs/patches/postrust-v3.4.0-graphql-type-names.patch`](./patches/postrust-v3.4.0-graphql-type-names.patch). It sanitizes custom type names in `pg_type_to_graphql`, the one function both registration and every reference go through, and a leading digit gets a `_` prefix. `public.fa_cases` becomes `public_fa_cases`. The patch file includes a regression test for that spelling.

The temporary layer includes this patch together with the null-RPC fix. `POSTGREST_VERSION=v3.4.0`, Compose, Podman, and CI build only the null-RPC patch. They do not include this GraphQL type-name change, and they still do not install the official image.

## Temporary patched artifact

Both defects are fixed together in `v3.4.0+supacloud.1`. The layer is already published at the release above and is what the host installer and tenant runtime pin by default. Rebuild it with:

```sh
bash scripts/build_postrust_temporary_fixes.sh
```

The script downloads the pinned source archive, checks its SHA-256, applies `docs/patches/postrust-v3.4.0-temporary-fixes.patch`, builds `postrust-server --features admin-ui,otel`, and verifies both the binary and the deterministic layer digest before writing `SHA256SUMS`. It requires Rust 1.94.1, `curl`, `patch`, GNU tar, and gzip. That Rust pin is the one that reproduces the published digests. Rebuilding this layer with the 1.98.1 toolchain from the `v3.4.0` source-build path does not reproduce those digests. `.github/workflows/postrust-temporary-fixes.yml` runs the same script on demand.

```
647e3f3d649f96adca20db8d8b774167d8b4129d186dfa76839e6ed8866c457e  usr/local/bin/postrust
e9e721400159b4e2cce78a860b2989cb67b3eb3628a232a57a0bd8a0072be79e  postrust-v3.4.0-supacloud.1-linux-amd64.tar.gz
```

This layer is a temporary SupaCloud artifact, not an upstream Postrust release. It is amd64 only. Replace it with the next official Postrust release once both fixes are upstream. Until then, `POSTGREST_VERSION=v3.4.0` remains the source-build path for the null-RPC patch. It is not a download of the official image.

## Conformance

Upstream [postgrest-conformance.md](https://github.com/postrust/postrust/blob/v3.4.0/docs/postgrest-conformance.md) at v3.4.0 reports 99.1% full-contract agreement over 1499 replayed PostgREST cases, and says that measurement used a binary built with `admin-ui,compat-key-order`. The temporary layer and the v3.4.0 source build use `admin-ui,otel`, which does not include `compat-key-order`. This repository has not replayed that suite. A passing compile of this pin is not that result.

`docs/adr/2026-11-24-postgrest-dataplane-unification.md` describes the data-plane direction. It is not a test result for this image and it does not authorize a production cutover.

No production host was upgraded, retagged, or deployed for this pin.
