# ZenStack data catalog

The compiler and ZenStack own one data catalog. REST and GraphQL are two
surfaces of that catalog. They share PostgreSQL `GRANT`, row level security,
and the GoTrue JWT. This document records that binding. It does not claim that
either client consumes a GraphQL schema generated from ZenStack. Hosted
`/graphql/v1` is Postrust Hasura; the catalog does not emit that SDL.

## Ownership

| Piece | Owner | What it is not |
| --- | --- | --- |
| Schema the model edits | ZenStack ZModel, through `@supacloud/db-zenstack` | A second policy engine, ledger, or connection router |
| REST execution | `postgrest`, `postrust`, or `lite` | The schema owner |
| Public GraphQL | Postrust Hasura at `/graphql/v1` | A generated SDL file, and not the Lite `pg_graphql` route |
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
| Upstream rewrite | `/v1/graphql` |
| `Accept-Profile` | not set |
| `Content-Profile` | not set |
| Dialect | `postrust-hasura` |
| Compiler client and `graphql-schema` export | the same `/graphql/v1` path |

`/internal/postrust/graphql` is not a catalog output and is not the public
GraphQL API. A configuration that sets a GraphQL dialect, a public path, a
role list, or a Hasura owner on `catalog` is rejected. The dialect is fixed;
the catalog does not select it.

## What the compiler writes

`supacloud-compiler database-contracts` accepts an optional `catalog` object:

```json
{
  "rootDir": ".",
  "outDir": "generated",
  "role": "authenticated",
  "catalog": {
    "schema": "zenstack/schema.zmodel",
    "restExecution": "postgrest"
  },
  "migrations": ["migrations/001.sql"]
}
```

`schema` is one self-contained `.zmodel` file inside `rootDir`. Imports are
not expanded. A `datasource` block, when present, must set provider
`postgresql`. `restExecution` names the PostgREST-compatible REST process.
`servesPublicRest` is true only for `postgrest`. `lite` and `postrust` stay
false in this catalog version. That flag is not the hosted REST deployment
record: public `/rest/v1` already runs pinned Postrust. Recording `postrust`
does not store the SDK parity run. The command
writes `data-catalog.json`
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

| Status | `reading` | Meaning |
| --- | --- | --- |
| `projected` | `row-policies-emitted` | At least one statement was emitted. `hash` is the SHA-256 of that SQL. `authorization.emittedRowPolicy` is true. `reason` is null. |
| `no-row-policy` | `no-row-policy-declared` | The projection ran and the ZModel declared no row policy. `hash` is the SHA-256 of that empty projection and is never null. `emittedRowPolicy` is false. |
| `not-projected` | `projection-incomplete` | A row predicate is outside the current projection, such as a relation predicate. The models stay in the inventory. `hash` is null, `reason` is required, and `emittedRowPolicy` is false. |

A null `hash` is valid only together with `reading: "projection-incomplete"` and a `reason`. It does not mean the schema needs no policy. The empty case keeps a hash and uses `no-row-policy-declared`. A document that pairs a null hash with `no-row-policy`, or a hash with `not-projected`, is rejected.

`authorization.emittedGrant` is always false.

## Residual gaps

These gaps are standing limits of catalog version 1. They are recorded on
every document so a missing key cannot be read as completed work.

| Gap | Still true |
| --- | --- |
| `rest-types-not-generated-from-catalog` | PostgREST `Database` types and OpenAPI still come from their existing snapshots. This catalog does not generate them. |
| `graphql-sdl-not-generated-from-catalog` | There is no ZModel-to-GraphQL generator. Role-scoped snapshots remain an export of `/graphql/v1`, not a file this catalog writes. |
| `grants-not-emitted-from-catalog` | `GRANT` is reviewed SQL. The catalog does not emit it. |
| `field-level-deny-not-projected` | Field-level `@deny` is not column privilege SQL. |
| `relation-predicates-not-projected` | Relation predicates are not guessed into subqueries. The projection fails closed and the catalog records `not-projected`. |
| `graphql-db-pre-request-not-applied` | GraphQL does not run `db-pre-request`. Singular `request.jwt.claim.*` settings stay unset. `auth.uid()` uses its `request.jwt.claims` fallback. |
| `lite-graphql-remains-pg-graphql` | Lite `/graphql/v1` still requires `pg_graphql`. It is not the hosted Postrust Hasura dialect. |
| `generated-typescript-model-not-proven-equal-to-zmodel` | `modelSchema` remains a separate generated TypeScript module. This contract does not prove it matches the ZModel. |

Also unchanged, and not claimed here:

- field-level policy, `FORCE ROW LEVEL SECURITY`, and command-host JWT claims;
- online `pg_get_expr` proof against the live catalog;
- a live check that a REST response and a GraphQL response return the same rows;
- npm publish, image retag, or deployment.

Ordinary reads stay on the PostgREST-compatible REST surface the project
already uses. Compiler-lane business writes stay on durable Command.
