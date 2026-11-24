# ADR: Public GraphQL moves to Postrust Hasura

## Status

Accepted for this repository's hosted `/graphql/v1` route. Not a production
deploy. Merging this record does not upgrade a host.

## Decision

Hosted project GraphQL is the Hasura dialect served by pinned Postrust
v3.4.0. `GET`/`POST /graphql/v1` rewrites to loopback `/v1/graphql`. The
gateway does not set `Accept-Profile` or `Content-Profile: graphql_public`.

`/rest/v1/rpc/graphql` is 404 on the project host. The `graphql_public.graphql`
function may still exist in the database. It is not a hosted HTTP API.

`SUPACLOUD_POSTRUST_GRAPHQL` stays a default-off management-listener probe.
It is not the public route.

Lite `/graphql/v1` executes the same read shape as SQL under the caller's
role: `query_root`, `where`, `order_by`, `limit`, and the foreign-key names
observed on the pinned binary. Mutations, aggregates, subscriptions,
relationship filters, and Relay documents are rejected there.

## What changes for clients

Documents that use `pg_graphql` Relay fields (`*Collection`, `edges`, `node`,
`*ByPk` in the Relay sense) do not run on hosted `/graphql/v1`. The hosted
fixture records a `validation-failed` error and no `data` object.

Callers export a role-scoped schema from `/graphql/v1` and author Hasura
documents against that snapshot. This repository does not ship a supabase-js
GraphQL adapter. The compiler client posts the document to `/graphql/v1`.

There is no per-project flag and no deprecation window inside the gateway.
The previous public implementation is retired on the HTTP surface in the same
change. Projects that called `/rest/v1/rpc/graphql` receive 404 and use
`/graphql/v1`.

## What stays

- One database per project.
- `anon`, `authenticated`, and `service_role` stay `NOLOGIN` on the hosted
  cluster. The connection user stays `authenticator_*`.
- Raw `/admin`, `/_`, `/api/graphql`, `/v1/graphql`, and `/v1alpha1/graphql`
  stay unpublished.
- GraphQL does not run `PGRST_DB_PRE_REQUEST`.
- Subscriptions stay off the project host.

## Evidence

`postrust-graphql-rls` fetches the pinned binary through
`supacloud_install_pinned_postrust_layer` and runs the hosted RLS fixture.
The same job runs `graphql-postrust-compare.local.test.ts`, which executes one
read document set on Lite and on that binary and compares the rows.
