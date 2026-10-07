# GraphQL Compatibility & Governance

SupaCloud keeps the Supabase GraphQL wire contract and delegates schema
reflection and execution to the real `pg_graphql` extension. The governance
layer validates application documents and exported role snapshots; it does not
replace `graphql.resolve`, PostgREST, PostgreSQL grants or RLS.

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

The matrix is derived from the actual snapshot. It reports the presence of
queries, mutations, subscriptions, Connection types, collection/filter/order
shapes, aggregates, `byPk` fields and query-root functions. It is a capability
report, not an implementation of those features.

The integration fixture remains the source of truth for real behavior:

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

The hosted Supabase-compatible route remains `/graphql/v1`, with the existing
`apikey`, Bearer token, `Accept-Profile: graphql_public` and
`Content-Profile: graphql_public` behavior.

## Studio Entry

GraphQL development tooling should call the existing `/graphql/v1` route with
an explicitly selected project key and development user token. Production
introspection remains disabled unless an operator intentionally enables it in
the selected database. A future Studio GraphQL page must remain a client of
this route; it must not introduce a second resolver or schema source.
