# Postrust GraphQL evaluation

This note describes a default-off way to call the GraphQL handler that is already compiled into the pinned Postrust v3.4.0 REST process. It is an architecture and vibecoding review surface. It does not switch public project GraphQL off `pg_graphql`.

The long-term shape is one data contract: the compiler and ZenStack own the schema the model edits, and REST and GraphQL are generated from that catalog with the same `GRANT` plus RLS and the same GoTrue JWT. That generation is not implemented here.

## What stays the default

- Public project GraphQL remains `GET`/`POST /graphql/v1` on the project API host.
- The gateway rewrites that path to `/rpc/graphql` on the tenant REST port and sets `Accept-Profile: graphql_public` and `Content-Profile: graphql_public`. That is `pg_graphql`.
- The management API proxy used for opaque API keys does the same `/graphql/v1` rewrite.
- Studio, the compiler GraphQL client, and the documented client handoff stay on `/graphql/v1`.
- The connection user stays the per-project `authenticator_*` role. `anon`, `authenticated`, `service_role`, `supabase_auth_admin`, and `supabase_admin` are unchanged. Isolation stays one database per project.
- No second policy engine, ledger, or connection router is added. GoTrue and Elixir Realtime are unchanged. Hasura is not added. `PGRST_HASURA_ADMIN_SECRET` and `PGRST_GRAPHQL_METADATA` are not set, so this path does not gain an admin-secret impersonation switch or a GraphQL permission document beside `GRANT` and RLS.

## Flag

`SUPACLOUD_POSTRUST_GRAPHQL`

Only the exact string `true` opens the evaluation handler. Unset, empty, `false`, `1`, `yes`, and `TRUE` leave it closed. `postrustGraphqlEvaluationEnabled` reads `process.env` when it is called, so a flip takes effect on the next request. It does not wait for a process restart. Project Caddy routes are a separate render: every `setupUpstream` deletes a stale project-host route id `route-project-<ref>-postrust-graphql` and does not add one, whether or not the flag is set. That deletion is visible on the next project route render. Adding an API domain does not attach that stale route to the new host.

The path is not a project API route. The name `/internal/postrust/graphql` is not the boundary. The handler lives on the management API listener, and only a credential that `hasProjectServiceRoleCredential` accepts for that project can open it. An `anon` or `authenticated` key alone receives 401 and is not forwarded. The caller's `Authorization` bearer is left in place, so the database role is still that token's `role` claim. An operator sends the project `service_role` credential in `apikey` and the user JWT in `Authorization`.

| | |
| --- | --- |
| Listener | Management API, not the project API host |
| Paths | `POST /internal/postrust/graphql` and the same path with a trailing slash |
| Gate | Project `service_role` credential |
| Upstream | The tenant REST port, rewritten to `/v1/graphql` |

The handler does not set `graphql_public` profile headers and does not set an admin secret.

These paths stay closed on the project host, including while the flag is on: `/internal/postrust/graphql`, `/api/graphql`, `/v1/graphql`, `/v1alpha1/graphql`, `/v1/graphql/ws`, and `/admin/graphql`. Subscriptions are not part of the evaluation route.

## What the pinned binary already does

Postrust v3.4.0 has no switch that removes GraphQL from the REST binary. The host tenant process sets `server-host = "127.0.0.1"` and answers `/v1/graphql`, `/v1alpha1/graphql`, and `/api/graphql` on that loopback port whether or not this flag is set. The flag does not reduce that process surface. It only decides whether the management listener will proxy one path to `/v1/graphql`. A client that can open the loopback port still reaches those paths. Compose and Podman do not publish the container port; the image listens on `0.0.0.0` inside its own network namespace. That exposure comes with the REST pin and is recorded in [Postrust v3.4.0 adoption](./postrust-v3.4.0-adoption.md).

In the v3.4.0 sources, `graphql_identity` in `crates/postrust-server/src/build.rs` uses the same JWT verifier as REST. The database role on the transaction is the verified token's `role` claim. `GraphQLContext::session` in `crates/postrust-graphql/src/context.rs` builds that transaction from the REST session, including `request.jwt.claims`, and then sets the database role. It passes `pre_request(false)`, so `db-pre-request` does not run. `public.set_request_context` therefore does not write `request.jwt.claim.sub`. `auth.uid()` in this repository also falls back to `request.jwt.claims`. GraphQL also leaves `search_path` as the role and database set it, rather than applying the REST extra search path.

A local run of `tests/integration/postrust-graphql-rls.local.test.ts` sent one `anon` JWT and two `authenticated` JWTs through the management handler to that upstream. `PGRST_DB_PRE_REQUEST` was `public.set_request_context`. Policies were `TO authenticated`. The `anon` JWT saw no rows. An `authenticated` JWT whose `sub` was `alice` saw no rows from a policy on `request.jwt.claim.sub`, and saw only the `alice` row from a policy on `request.jwt.claims ->> sub`. The `bob` token saw only the `bob` row on that second policy. The singular setting is fail-closed. The claims document is row-scoped for that fixture. This is not a nested-query, supabase-js, or `auth.uid()` execution test.

With no admin secret configured, bare `x-hasura-*` headers do not choose the database role. `X-Hasura-Role` can select among roles only when the verified token itself lists them in `x-hasura-allowed-roles`. GoTrue tokens issued here do not carry that list.

Opaque API keys are translated on `/graphql/v1` before the request reaches `pg_graphql`. The evaluation route dials the REST port directly and does not run that translation.

## What this change checked

`bun test tests/unit/postrust-graphql-evaluation.test.ts` checks the flag parser, the default Caddy `/graphql/v1` rewrite to `/rpc/graphql`, that the project host stays closed while the flag is `true`, and that the management listener returns 404 while the flag is off, 401 for an `anon` credential, and proxies a `service_role` credential to `/v1/graphql` while keeping the caller bearer.

`SUPACLOUD_TEST_POSTRUST_GRAPHQL=1 bun test tests/integration/postrust-graphql-rls.local.test.ts` is the local RLS run described above. It is skipped unless that variable and `POSTRUST_BIN` are set. CI does not run it.

## Remaining gaps

- The dialect is Hasura's (`query_root`, `where`, `order_by`), not `pg_graphql`'s Relay connections. This is not bit-for-bit compatibility with `pg_graphql`, and it is not a claim that it should be.
- Not run, and not claimed as passed: supabase-js or another GraphQL client, nested queries, error-shape comparison, `auth.uid()` itself, or Postrust's Hasura conformance harness. The one local RLS fixture above is the only live GraphQL query this change ran.
- #2786 is on main. SDK parity for `from().select().order()` remains a REST question. This route keeps `/graphql/v1` on `pg_graphql`.
- The compiler still pulls and checks the `pg_graphql` schema at `/graphql/v1`. Generating REST and this GraphQL surface from the ZenStack catalog is future work. No compiler or ZenStack hook was added.
- `db-pre-request`, singular `request.jwt.claim.*` settings, REST `search_path`, opaque API keys, and GraphQL subscriptions are outside this route.
