# ZenStack data catalog

The compiler and ZenStack own one data catalog. REST and GraphQL are two
surfaces of that catalog. They share PostgreSQL `GRANT`, row level security,
and the GoTrue JWT. This document is the contract for that binding. It is not
a cutover, and it does not claim that either client already consumes a GraphQL
schema generated from ZenStack.

## Ownership

| Piece | Owner | What it is not |
| --- | --- | --- |
| Schema the model edits | ZenStack ZModel, through `@supacloud/db-zenstack` | A second policy engine, ledger, or connection router |
| REST execution | `postgrest`, `postrust`, or `lite` | The schema owner. Postrust serves PostgREST-compatible REST only |
| Public GraphQL | `pg_graphql` at `/graphql/v1` | Postrust's Hasura-dialect GraphQL, and not a generated SDL file |
| Enforcement | PostgreSQL `GRANT` and RLS for `anon`, `authenticated`, and `service_role` | A rename of those roles, or of `supabase_auth_admin` / `supabase_admin` |
| Identity | Verified GoTrue JWT, then the token role inside the transaction | A second auth store |
| Isolation | One database per project | A schema-per-tenant router |

The request order stays:

```text
verified GoTrue JWT
  -> role in {anon, authenticated, service_role}
  -> PostgreSQL GRANT + RLS
```

ZenStack row policy is the model adapter. It does not replace `GRANT` or RLS.
The command ledger and the tenant bootstrap ledger stay separate. Management
API, GoTrue, and Elixir Realtime are unchanged.

## Public GraphQL entry

These values are fixed by `PUBLIC_GRAPHQL_CONTRACT` in
`@supacloud/compiler`. The catalog cannot select another path or dialect.

| | |
| --- | --- |
| Project path | `/graphql/v1` |
| Upstream rewrite | `/rpc/graphql` |
| `Accept-Profile` | `graphql_public` |
| `Content-Profile` | `graphql_public` |
| Dialect | `pg_graphql` |
| Compiler client and `graphql-schema` export | the same `/graphql/v1` path |

Studio and the management API proxy are not retargeted by this contract.
`/internal/postrust/graphql` is not a catalog output and is not the public
GraphQL API. A configuration that sets a GraphQL dialect, a public path, a
role list, or a Hasura owner on `catalog` is rejected.

## What the compiler writes

`supacloud-compiler database-contracts` accepts an optional `catalog` object:

```json
{
  "rootDir": ".",
  "outDir": "generated",
  "role": "authenticated",
  "catalog": {
    "schema": "zenstack/schema.zmodel",
    "restExecution": "postrust"
  },
  "migrations": ["migrations/001.sql"]
}
```

`schema` is one self-contained `.zmodel` file inside `rootDir`. Imports are
not expanded. A `datasource` block, when present, must set provider
`postgresql`. `restExecution` is `postgrest`, `postrust`, or `lite`. The
command writes `data-catalog.json`
next to the existing database contract and hashes the ZModel into
`database.manifest.json`. `--check` fails when that file or the manifest
drifts, and it does not write.

The document inventories models, mapped tables, columns, enums, and the
`@@auth()` claim names. `schemaHash` is the SHA-256 of the ZModel source.
Both surfaces point at `schemaOwner: "zenstack"` and at that hash.
`generatedFromCatalog` is `false` for REST types and for GraphQL SDL.

If `modelPolicy` is set, it must be the same ZModel. The existing `rls.sql`
emission and migration-ledger check still apply and still fail closed. The
catalog does not replace that check.

`policyRls.status` is the result of the existing row-policy projection for the
`authenticated` role:

| Status | Meaning |
| --- | --- |
| `projected` | The projection emitted at least one statement. `authorization.emittedRowPolicy` is true. `hash` is the SHA-256 of that SQL. |
| `no-row-policy` | The projection ran and emitted no statements. `hash` still covers that empty projection. `emittedRowPolicy` is false. |
| `not-projected` | A row predicate is outside the current projection, such as a relation predicate. The models stay in the inventory. `hash` is null and `emittedRowPolicy` is false. |

`authorization.emittedGrant` is always false.

## Residual gaps

These gaps are standing limits of catalog version 1. They are recorded on
every document so a missing key cannot be read as completed work.

| Gap | Still true |
| --- | --- |
| `rest-types-not-generated-from-catalog` | PostgREST `Database` types and OpenAPI still come from their existing snapshots. This catalog does not generate them. |
| `graphql-sdl-not-generated-from-catalog` | There is no ZModel-to-GraphQL generator. Role-scoped `pg_graphql` snapshots remain an export of the database, not a file this catalog writes. |
| `grants-not-emitted-from-catalog` | `GRANT` is reviewed SQL. The catalog does not emit it. |
| `field-level-deny-not-projected` | Field-level `@deny` is not column privilege SQL. |
| `relation-predicates-not-projected` | Relation predicates are not guessed into subqueries. The projection fails closed and the catalog records `not-projected`. |
| `public-graphql-remains-pg-graphql` | `/graphql/v1` is still the `pg_graphql` rewrite. Clients are not switched. |
| `postrust-hasura-graphql-is-not-the-contract` | Postrust Hasura GraphQL is not the schema owner and not the public contract. |
| `generated-typescript-model-not-proven-equal-to-zmodel` | `modelSchema` remains a separate generated TypeScript module. This contract does not prove it matches the ZModel. |

Also unchanged, and not claimed here:

- field-level policy, `FORCE ROW LEVEL SECURITY`, and command-host JWT claims;
- online `pg_get_expr` proof against the live catalog;
- a live check that a REST response and a GraphQL response return the same rows;
- npm publish, image retag, or deployment.

Ordinary reads stay on the PostgREST-compatible REST surface the project
already uses. Compiler-lane business writes stay on durable Command.
