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

`/rest/v1/rpc/graphql` is closed on the project host. The gateway and the project REST proxy answer it with 404 before the request reaches `graphql_public.graphql`. Other `/rest/v1/rpc/*` functions stay available. The database function can still exist for a direct database session; it is not a hosted HTTP GraphQL API.

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

- a Relay `claim_sub_notesCollection` / `edges` / `node` query is HTTP 200 with `errors[0].extensions.code` `validation-failed`, no `data` field, and a message that names the missing field on `query_root`;
- an `anon` JWT sees no rows;
- `request.jwt.claim.sub` sees no rows for `authenticated` (fail-closed, because pre-request did not run);
- `request.jwt.claims ->> sub` returns only the caller's row;
- `auth.uid()` returns only the caller's row for UUID `sub` values;
- a nested author-to-notes selection returns only the caller's note under that author, and none of the other author's notes.

The same file skips when `SUPACLOUD_TEST_POSTRUST_GRAPHQL` is not `1` or `POSTRUST_BIN` is unset.

## What stays default-off

`SUPACLOUD_POSTRUST_GRAPHQL` still opens only `POST /internal/postrust/graphql` on the management listener, and only for a credential `hasProjectServiceRoleCredential` accepts. An `anon` or `authenticated` key alone is 401 and is not forwarded. Unset, empty, `false`, `1`, `yes`, and `TRUE` leave that listener path closed. Project Caddy renders still delete a stale `route-project-<ref>-postrust-graphql` and do not add one. That path is not the public API and does not replace opaque-key translation on `/graphql/v1`.

## Hosted documents

A Relay query (`*Collection`, `edges`, `node`) sent to `/graphql/v1` is rejected. The CI fixture expects HTTP 200 and this body, with no `data` field and no empty `edges` list:

```json
{
  "errors": [{
    "message": "field 'claim_sub_notesCollection' not found in type: 'query_root'",
    "extensions": {
      "code": "validation-failed",
      "path": "$.selectionSet.claim_sub_notesCollection"
    }
  }]
}
```

That is the measured hosted rejection for that document. A `pg_graphql` error document was not replayed beside it, so envelope parity with `pg_graphql` stays unmeasured.

This repository does not ship a supabase-js GraphQL adapter. Callers post a Hasura document to `/graphql/v1`, or use the compiler client generated from a role-scoped export of that route.

## Limits that remain

- GraphQL does not call `PGRST_DB_PRE_REQUEST`. Upstream documents that setting as REST-only. Singular `request.jwt.claim.*` stays unset. `auth.uid()` in the CI fixture succeeds because the function falls back to `request.jwt.claims`. REST `search_path` is not applied.
- Postrust v3.4.0 GraphQL subscriptions stay on paths this gateway keeps closed, including `/v1/graphql/ws` and `/admin`. Publishing those paths is not how this route gains subscriptions.
- Lite `/graphql/v1` executes the same read shape as SQL in the caller's transaction: `query_root`, `where`, `order_by`, `limit`, and foreign-key fields named the way Postrust v3.4.0 names them (`notes` for the child table, `author` for `author_id`). `LITE_GRAPHQL_CONTRACT.interchangeableWithHosted` is true for that read contract. Mutations, aggregates, subscriptions, and relationship filters are rejected. Lite does not call `db-pre-request` and does not embed Postrust.
- Postrust's Hasura conformance harness was not replayed here.
- The catalog does not emit GraphQL SDL or `GRANT`.
- No production host was upgraded, retagged, or deployed for this cutover.
