# Postrust GraphQL evaluation

This note describes a default-off way to call the GraphQL handler that is already compiled into the pinned Postrust v3.4.0 REST process. It is an architecture and vibecoding review surface. It does not switch public project GraphQL off `pg_graphql`.

The long-term shape is one data contract: the compiler and ZenStack own the schema the model edits, and REST and GraphQL are generated from that catalog with the same `GRANT` plus RLS and the same GoTrue JWT. That generation is not implemented here.

## What stays the default

- Public project GraphQL remains `GET`/`POST /graphql/v1` on the project API host.
- The gateway rewrites that path to `/rpc/graphql` on the tenant REST port and sets `Accept-Profile: graphql_public` and `Content-Profile: graphql_public`. That is `pg_graphql`.
- The management API proxy used for opaque API keys does the same rewrite. It does not grow a Postrust GraphQL route.
- Studio, the compiler GraphQL client, and the documented client handoff stay on `/graphql/v1`.
- The connection user stays the per-project `authenticator_*` role. `anon`, `authenticated`, `service_role`, `supabase_auth_admin`, and `supabase_admin` are unchanged. Isolation stays one database per project.
- No second policy engine, ledger, or connection router is added. GoTrue and Elixir Realtime are unchanged. Hasura is not added. `PGRST_HASURA_ADMIN_SECRET` and `PGRST_GRAPHQL_METADATA` are not set, so this path does not gain an admin-secret impersonation switch or a GraphQL permission document beside `GRANT` and RLS.

## Flag

`SUPACLOUD_POSTRUST_GRAPHQL`

The management API reads this variable when it renders Caddy routes. Only the exact string `true` opens the route. Unset, empty, `false`, `1`, `yes`, and `TRUE` leave it closed. A process that is already running keeps the routes it last rendered until the next reconciliation after it starts with the new value.

When the flag is `true`, each project API host gains one route, `route-project-<ref>-postrust-graphql`:

| | |
| --- | --- |
| Project paths | `/internal/postrust/graphql` and the same path with a trailing slash |
| Upstream | The existing tenant REST port, the same process as `/rest/v1` |
| Rewrite | `/v1/graphql` |

The route does not set `graphql_public` profile headers and does not set an admin secret. Authorization is whatever that process already does for a GraphQL request: verify the GoTrue JWT and run the transaction as the token's database `role`.

These project-host paths stay closed, including while the flag is on: `/api/graphql`, `/v1/graphql`, `/v1alpha1/graphql`, `/v1/graphql/ws`, `/admin/graphql`, and `/internal/postrust/graphql/ws`. Subscriptions are not part of the evaluation route.

## What the pinned binary already does

Postrust v3.4.0 has no switch that removes GraphQL from the REST binary. On the tenant port (`server-host = 0.0.0.0`) the process answers `/v1/graphql`, `/v1alpha1/graphql`, and `/api/graphql` whether or not this flag is set. The flag only decides whether the project API gateway publishes `/internal/postrust/graphql`. Reaching the tenant port directly still reaches those process paths. That exposure comes with the REST pin. It is not a public project route, and this change does not add one.

In the v3.4.0 sources, `graphql_identity` in `crates/postrust-server/src/build.rs` uses the same JWT verifier as REST. The database role on the transaction is the verified token's `role` claim. `GraphQLContext::session` in `crates/postrust-graphql/src/context.rs` builds that transaction from the REST session, including `request.jwt.claims`, and then sets the database role. It passes `pre_request(false)`, so `db-pre-request` does not run. `public.set_request_context` therefore does not write `request.jwt.claim.sub`, `request.jwt.claim.role`, or `request.jwt.claim.email`. `auth.uid()` and `auth.role()` in this repository also fall back to `request.jwt.claims`. That fallback was not executed against this route. GraphQL also leaves `search_path` as the role and database set it, rather than applying the REST extra search path.

With no admin secret configured, bare `x-hasura-*` headers do not choose the database role. `X-Hasura-Role` can select among roles only when the verified token itself lists them in `x-hasura-allowed-roles`. GoTrue tokens issued here do not carry that list.

Opaque API keys are translated on `/graphql/v1` before the request reaches `pg_graphql`. The evaluation route dials the REST port directly and does not run that translation.

## What this change checked

`bun test tests/unit/postrust-graphql-evaluation.test.ts` checks the flag parser, the default Caddy `/graphql/v1` rewrite to `/rpc/graphql`, that the flag is required to publish `/internal/postrust/graphql`, that turning the flag off removes that route, and that the management API proxy still targets `/rpc/graphql` and does not serve the evaluation path. Those tests do not start Postrust or PostgreSQL.

## Remaining gaps

- The dialect is Hasura's (`query_root`, `where`, `order_by`), not `pg_graphql`'s Relay connections. This is not bit-for-bit compatibility with `pg_graphql`, and it is not a claim that it should be.
- Not run, and not claimed as passed: a live GraphQL query, supabase-js or another GraphQL client, nested queries, RLS, error-shape comparison, or Postrust's Hasura conformance harness.
- The compiler still pulls and checks the `pg_graphql` schema at `/graphql/v1`. Generating REST and this GraphQL surface from the ZenStack catalog is future work. No compiler or ZenStack hook was added.
- `db-pre-request`, singular `request.jwt.claim.*` settings, REST `search_path`, opaque API keys, and GraphQL subscriptions are outside this route.
