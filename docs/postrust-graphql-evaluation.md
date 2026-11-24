# Postrust GraphQL

Public project GraphQL at `GET`/`POST /graphql/v1` is the Hasura dialect served by the pinned Postrust v3.4.0 process. This is not bit-for-bit compatibility with `pg_graphql`, and it is not a second policy engine.

The long-term shape is still one data contract: the compiler and ZenStack own the schema the model edits, and REST and GraphQL share `GRANT`, RLS, and the GoTrue JWT. Generating SDL from that catalog is not implemented. `generatedFromCatalog` stays false.

## Public route

| | |
| --- | --- |
| Project path | `GET`/`POST /graphql/v1` |
| Upstream | Tenant REST port, loopback `127.0.0.1`, rewritten to `/v1/graphql` |
| Profile headers | Not set. There is no `graphql_public` `Accept-Profile` or `Content-Profile` on this route. |
| Dialect | Postrust Hasura: `query_root`, `where`, `order_by`, `limit` |
| Flag | `SUPACLOUD_POSTRUST_GRAPHQL` does not control this route |

The Caddy project route matches `/graphql/v1*` and rewrites that URI to `/v1/graphql` on `127.0.0.1:<tenant REST port>`. Opaque `sb_publishable_` and `sb_secret_` keys still match the management API proxy first. That proxy translates the opaque key, leaves the caller `Authorization` bearer in place, and forwards to the same `/v1/graphql` upstream. A JWT-shaped key that does not match the opaque matcher goes to the loopback rewrite directly, the same split REST already uses.

`anon`, `authenticated`, and `service_role` stay cluster-wide `NOLOGIN`. The connection user stays the per-project `authenticator_*` role. Postrust sets the database role from the verified token's `role` claim. `supabase_auth_admin` and `supabase_admin` are unchanged. Isolation stays one database per project.

These client paths stay closed on the project host: `/internal/postrust/graphql`, `/api/graphql`, `/v1/graphql`, `/v1alpha1/graphql`, `/v1/graphql/ws`, and `/admin/graphql`. A `/rest/v1` request whose suffix is `/admin`, `/_`, `/api/graphql`, `/v1/graphql`, or `/v1alpha1/graphql` is still 404 before the prefix strip. The tenant process stays bound to `127.0.0.1`. The official image still serves those raw handlers on the loopback port; the gateway does not publish them. `/graphql/v1` is the rewrite onto the handler, not a new public match for `/v1/graphql`.

`/rest/v1/rpc/graphql` is unchanged. When `graphql_public.graphql` exists, that REST RPC can still reach `pg_graphql`. It is not the public `/graphql/v1` implementation.

## Dialect the compiler and clients use

Hosted documents are Hasura-shaped. A role-scoped export from `/graphql/v1` is Postrust introspection, not a `pg_graphql` Relay connection schema. The compiler client and `graphql-schema` still post to `/graphql/v1`. They do not call `/v1/graphql` or `/internal/postrust/graphql`.

`PUBLIC_GRAPHQL_CONTRACT` records `dialect: "postrust-hasura"`, `rewritePath: "/v1/graphql"`, and null profile headers. The catalog does not accept another dialect, path, or owner. Relay `*Collection` / `edges` / `node` documents are the `pg_graphql` shape. They are not the hosted contract. Lite `/graphql/v1`, when enabled, still requires the real `pg_graphql` extension and is not this dialect.

The feature matrix reports both shapes from the snapshot it is given: Relay connections, and Hasura `where` / `order_by` arguments plus a `query_root` query type. It does not execute either engine.

`scripts/check_graphql_pilot.ts` still exercises `pg_graphql` through `/rpc/graphql`. It is not evidence for this hosted route.

## RLS that CI runs

`PGRST_DB_PRE_REQUEST` is REST-only. GraphQL does not call it, so `public.set_request_context` does not write `request.jwt.claim.sub`. `GraphQLContext` still sets `request.jwt.claims` and the database role. `auth.uid()` in this repository reads the singular setting and falls back to `request.jwt.claims ->> sub`.

`.github/workflows/management-api.yml` job `postrust-graphql-rls` installs PostgreSQL 16, downloads the pinned v3.4.0 layer, checks the layer digest and the binary SHA256 `f174c84a1b3ac8a24c13a4ef7896adfc029ece8c1b206ee715e3864f5f169b7a`, and runs:

```sh
SUPACLOUD_TEST_POSTRUST_GRAPHQL=1 POSTRUST_BIN=<pinned binary> \
  bun test tests/integration/postrust-graphql-rls.local.test.ts
```

The workflow runs that from `packages/management-api`.

That fixture sends an opaque publishable key plus the caller bearer through public `/graphql/v1` with the evaluation flag unset. Policies are `TO authenticated`. The run asserts:

- an `anon` JWT sees no rows;
- `request.jwt.claim.sub` sees no rows for `authenticated` (fail-closed, because pre-request did not run);
- `request.jwt.claims ->> sub` returns only the caller's row;
- `auth.uid()` returns only the caller's row for UUID `sub` values;
- a nested author-to-notes selection returns only the caller's note under that author, and none of the other author's notes.

The same file skips when `SUPACLOUD_TEST_POSTRUST_GRAPHQL` is not `1` or `POSTRUST_BIN` is unset.

## What stays default-off

`SUPACLOUD_POSTRUST_GRAPHQL` still opens only `POST /internal/postrust/graphql` on the management listener, and only for a credential `hasProjectServiceRoleCredential` accepts. An `anon` or `authenticated` key alone is 401 and is not forwarded. Unset, empty, `false`, `1`, `yes`, and `TRUE` leave that listener path closed. Project Caddy renders still delete a stale `route-project-<ref>-postrust-graphql` and do not add one. That path is not the public API and does not replace opaque-key translation on `/graphql/v1`.

## Not claimed

- Relay `pg_graphql` documents work on hosted `/graphql/v1`.
- `db-pre-request`, singular `request.jwt.claim.*` settings, or the REST `search_path` run for GraphQL.
- GraphQL subscriptions, a supabase-js GraphQL client, or error-shape parity with `pg_graphql`.
- Postrust's Hasura conformance harness was replayed here.
- Lite serves this dialect.
- The catalog emits GraphQL SDL or `GRANT`.
- A production host was upgraded, retagged, or deployed.
