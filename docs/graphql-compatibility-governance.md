# GraphQL Compatibility & Governance

Hosted `/graphql/v1` is Postrust GraphQL in the Hasura dialect. The governance
layer validates application documents and exported role snapshots; it does not
replace Postrust, PostgreSQL grants, or RLS. Lite `/graphql/v1` executes the
same Hasura read shape and rejects the operations listed on
`LITE_GRAPHQL_CONTRACT`. A Relay snapshot is not a hosted snapshot.

## Compatibility Check

Run the check against a role-scoped local snapshot:

```sh
supacloud-compiler graphql compatibility \
  --schema graphql/schema.graphql \
  --documents src/**/*.graphql \
  --policy graphql/policy.json
```

The report includes:

- schema hash and normalized schema hash;
- detected `pg_graphql`-shaped capabilities;
- query/mutation/subscription operation inventory;
- depth, selected-field count, simple complexity and page-size budgets;
- operation allowlist violations;
- GraphQL validation errors.

`policy.json` is a checked-in application policy, for example:

```json
{
  "operations": ["OrderDetail", "OrderList*"],
  "maxDepth": 8,
  "maxFields": 80,
  "maxComplexity": 120,
  "maxPageSize": 100
}
```

The limits are a release-time gate. Runtime request size and database timeout
remain enforced by the selected Supabase-compatible runtime.

## Role Snapshots

Keep separate snapshots for the roles that applications actually use:

```sh
supacloud-compiler graphql roles \
  --role anon=graphql/schema.anon.graphql \
  --role authenticated=graphql/schema.authenticated.graphql \
  --role service_role=graphql/schema.service_role.graphql
```

Never use a service-role snapshot as proof that an anonymous or authenticated
caller can see the same schema. Snapshot export still uses the existing
`graphql-schema` command and an explicitly selected caller credential.

## Breaking Changes

Compare the last promoted snapshot with the candidate:

```sh
supacloud-compiler graphql diff \
  --base graphql/schema.authenticated.previous.graphql \
  --current graphql/schema.authenticated.graphql
```

The diff fails for removed types or fields, changed field and argument types,
removed arguments, removed input fields, and newly required arguments. Added
optional fields and types are reported as non-breaking.

## Feature Matrix

The matrix is derived from the actual snapshot. It reports queries, mutations,
subscriptions, Relay connection types, Hasura `where` and `order_by` arguments,
a `query_root` query type, aggregates, and `byPk` fields. It is a capability
report, not an implementation of those features.

`scripts/check_graphql_pilot.ts` remains the `pg_graphql` behavior fixture. It
is not the hosted Postrust route. Hosted RLS evidence is the
`postrust-graphql-rls` CI job described in
[Postrust GraphQL](postrust-graphql-evaluation.md).

The `pg_graphql` pilot:

```sh
bun run scripts/check_graphql_pilot.ts
```

It must continue to exercise role-scoped RLS, nested relations, denied writes,
schema drift and equivalent PostgREST behavior. Do not add a fake GraphQL
executor to make the fixture pass.

## Runtime Metrics

Lite accepts:

```toml
[lite.graphql]
slow_query_threshold_ms = 1000
statement_timeout_ms = 30000
```

Embedded callers may provide `onRequest` in `GraphqlOptions`. The callback
receives operation name, HTTP status, duration and a slow flag. Query text,
variables, authorization headers and database exception text are never included
in the metric payload.

The hosted route remains `/graphql/v1`, with the existing `apikey` and Bearer
token behavior. The gateway rewrites it to Postrust `/v1/graphql` and does not
set `Accept-Profile` or `Content-Profile`. The compiler data catalog records
that this route and PostgREST-compatible REST share one ZenStack schema. That
record does not generate a GraphQL schema. See
[ZenStack data catalog](zenstack-data-catalog.md).

## Studio Entry

GraphQL development tooling should call the existing `/graphql/v1` route with
an explicitly selected project key and development user token. Production
introspection remains disabled unless an operator intentionally enables it in
the selected database. A future Studio GraphQL page must remain a client of
this route; it must not introduce a second resolver or schema source.
