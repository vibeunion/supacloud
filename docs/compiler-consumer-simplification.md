# Compiler Consumer Simplification

## Ownership

Customers maintain business queries/fragments, database declarations, a role-scoped
schema snapshot exported by `graphql-schema`, project configuration, and business
policy. They should not maintain a second compiler for generated query results.

SupaCloud owns operation types, result validation, the query client, artifact drift
checks, watch/incremental compilation, route conflict checks, and configurable
module/command governance.

This change does not migrate customer repositories, publish packages, generate
business queries from table inventories, or infer business authorization rules.
It does not add a general TypeScript-to-schema compiler for arbitrary DTOs.

## Acceptance

```gherkin
Scenario: A query result crosses an untrusted boundary
  Given an exported database schema and a named business query
  When the customer compiles and calls the generated client
  Then selected result fields are validated before typed data is returned
  And incorrect fields fail with invalid-response without exposing their values
  And no customer code generator or runtime package is required

Scenario: Query shape stays the single source of truth
  Given aliases, fragments, enums, lists, conditional fields and nullable relations
  When operation types and validators are generated
  Then both describe the same selected result shape
  And unmapped custom scalars remain explicitly unknown
  And unsupported non-JSON scalar types fail compilation

Scenario: Existing transports reuse validation
  Given a customer supplies a requester returning untrusted data
  When a generated SDK method receives that data
  Then the same operation validator runs
  And standalone parsers are available for other integration boundaries

Scenario: Standard configuration replaces generic wrapper code
  Given module boundary and type safety rules in supacloud.config.ts
  When compile, check or dev resolves the configuration
  Then those rules reach the existing compiler pipeline
  And check compares generated validators without writing temporary artifacts
  And a failed compilation preserves the last successful query client
```

## Migration

Use `supacloud-compiler compile`, `supacloud-compiler check`, and
`supacloud-compiler dev` with `defineSupacloudConfig`. Configuration supports
`moduleBoundaries`, `typeSafety`, `commandCapabilities`,
`allowRouteCommandBindings`, `disallowControllerDirectDb`, and
`detectOrphanModules`, in addition to the existing GraphQL options. Set
`allowRouteCommandBindings: false` when Commands already pass through the
application's own execution boundary. Keep truly application-specific checks
separate. Invalid governance option shapes are rejected when loading config.

After upgrading and regenerating, remove result-schema postprocessing for calls
using `createGraphqlClient` or `getSdk`: both validate results automatically.
`parse<OperationName>Query(unknown)` and `is<OperationName>Query(unknown)` are
exported from `generated/graphql.ts` for other callers. These validate selected
JSON result shapes, not authorization, semantic scalar formats, or live database
schema freshness. `unknown` custom scalar payloads still require domain narrowing.

For an adapter that dispatches by query name, use the generated
`GraphqlQueryResults` map and `parseGraphqlResult(name, value)`. Map keys are named
operations without the `Query` suffix. For example,
`GraphqlQueryResults["FACatalogMethods"]` replaces the corresponding customer
result registry entry. Keep tenant checks, bounded pagination, scalar conversion,
and business enum validation in the customer service.

Keep `catalog.graphql` or equivalent business queries. Do not remove an existing
runtime validator until every consumer has moved to a validated official entry
point. Existing TypeBox schemas used for unrelated HTTP/Command contracts remain.
