# GraphQL Query Contracts

## Database First Only

The only supported server-schema model is **Database First**. Drizzle table
definitions and reviewed SQL governance declarations are applied to PostgreSQL;
`pg_graphql` reflects the actual database under the intended caller role.
`graphql/schema.graphql` (or introspection JSON) is an exported, derived snapshot,
not an independently authored API definition. Change the database declarations,
apply migrations, then export again. Do not edit the snapshot to make a query pass.

```text
Drizzle + SQL grants/policies -> migrated PostgreSQL -> pg_graphql
  -> role-scoped local snapshot + authored queries/fragments
  -> validated operation types, typed client and optional TypedDocumentNode
```

There is no Code First decorator/resolver mode, handwritten server SDL mode, or
Drizzle-to-GraphQL generator. `@Query` in the application framework does not define
a GraphQL resolver. SDL and introspection JSON are two snapshot formats, not two
authoring modes; TypedDocumentNode is an output option, not another schema model.
Only `schema`, `documents`, `scalars` and `typedDocuments` configure this pipeline.
The schema must be a local `.graphql`, `.gql` or `.json` snapshot, not TypeScript,
inline SDL or a remote URL. Compilation never fetches or executes a schema source.

The starter's synthetic snapshot is only an offline test fixture. It is not
database provenance and must be replaced with a role-scoped export before
integration. A generated-file notice is an editing guardrail, not attestation:
offline compilation cannot prove where SDL came from or whether the remote
database has changed. The explicit `graphql-schema --check` database comparison
is required after migrations or grants change and before promotion, together with
the application's typecheck and role/RLS tests. Keep snapshots in version control;
never store the exporting user's credentials in them.

### Acceptance Criteria

```gherkin
Scenario: Only the database-backed schema workflow is supported
  Given an enabled GraphQL configuration
  When it requests a decorator, resolver or handwritten schema authoring mode
  Then compilation rejects the unsupported configuration
  And no replacement GraphQL artifacts are written

Scenario: Local editing cannot substitute for a database change
  Given a role-scoped snapshot exported from the selected database
  When its SDL is edited and graphql-schema --check is run against that database
  Then the check reports drift without overwriting the snapshot
  And a subsequent explicit export restores the database-derived content

Scenario: Day-to-day development remains offline
  Given a local role-scoped snapshot and named queries
  When compile, check or dev runs
  Then operations are validated and types are derived without database access
  And a query for a nonexistent field is rejected

Scenario: The starter does not invent a deployed schema
  Given a newly initialized application
  When its offline query example is inspected
  Then the snapshot is identified as a synthetic fixture
  And integration instructions require a database export and drift check
```

## Scope

Make database-backed read queries easy to write, validate and call without
introducing a second application runtime. The platform extension remains opt-in.
New `supacloud app init` projects preconfigure query contracts as the recommended
read path. General App/compiler configuration and the low-level `compileProject`
API enable contracts only when `graphql` is configured. Existing REST,
Command-only and background-task projects do not need a schema or dummy query.
Once adopted, invalid queries and missing schemas are always errors, including
with `strict: false` or `--no-strict`. Explicit `graphql: false` or `--no-graphql`
opts the project/run out; there is no per-query validation bypass. Existing REST
and Command APIs remain unchanged.

The compiler uses a local role-scoped schema snapshot and standard GraphQL
documents. GraphQL.js validates operations; GraphQL Code Generator generates
operation types; a thin generated facade sends isolated operations and their
fragments using fetch. Compilation does not contact a database, enable
an extension, change grants, or enable production introspection.

Mutations and subscriptions are outside this first version. Query-only compilation
is a developer guardrail, not an authorization boundary: database grants and RLS
must independently prevent unauthorized reads and writes, including requests
sent without the generated client. PostgreSQL functions exposed as queries also
require review for side effects.

## Usage

`supacloud app init` includes the configuration, example snapshot, query and
offline client test. For an existing project:

```ts
import { defineSupacloudConfig } from "@supacloud/compiler";

export default defineSupacloudConfig({
  root: "src",
  graphql: {
    schema: "graphql/schema.graphql",
    documents: ["**/*.graphql", "**/*.gql"],
    // Optional explicit wire mappings; other custom scalars remain unknown.
    scalars: { BigInt: { input: "string", output: "string" } },
  },
});
```

Schema paths are relative to the configuration directory; document patterns are
relative to `root`. The programmatic `compileProject` API resolves relative schema
paths against `rootDir`. SDL and introspection JSON snapshots are supported.

Export from an explicitly selected development project under the intended caller
identity, not an administrator or service-role identity:

```sh
supacloud-compiler graphql-schema \
  --url https://your-project.example \
  --key-env SUPACLOUD_PUBLISHABLE_KEY \
  --token-env APP_USER_ACCESS_TOKEN
supacloud-compiler compile
supacloud-compiler check --json
supacloud-compiler dev
```

Environment flags contain variable names only. Export requires an already-enabled
GraphQL endpoint and development introspection. It performs one authenticated
request with a timeout, refuses redirects and requires HTTPS outside loopback.
It writes only a validated schema, never credentials. Normal compilation is
offline and does not refresh snapshots implicitly.

After applying migrations in a controlled test environment, run the same export
command with `--check --json`. A missing or changed snapshot exits 1, reports
`upToDate: false`, and does not write. Intentionally export the new snapshot,
then run compile/check, frontend typecheck and database permission tests before
promotion. This is an explicit post-migration gate, not an automatic migration hook.

For an existing GraphQL transport, optionally set `graphql.typedDocuments: true`
and install `@graphql-typed-document-node/core` in the consuming application.
The compiler also emits `graphql.documents.ts` with standard TypedDocumentNode
operations generated by GraphQL Code Generator:

```ts
import type { ResultOf, VariablesOf } from "@graphql-typed-document-node/core";
import { ReviewListDocument } from "./generated/graphql.documents";

type ReviewListResult = ResultOf<typeof ReviewListDocument>;
type ReviewListVariables = VariablesOf<typeof ReviewListDocument>;
```

The optional document file participates in artifact drift checks and contains
only type imports for the typed-document library. This does not add a second
transport or permit mutations.

Write a named operation in `src/review/reviews.graphql`, for example:

```graphql
query ReviewList($first: Int = 20) {
  reviewCollection(first: $first) {
    edges { node { id state version } }
  }
}
```

The names must exist in the exported schema. The starter schema is a synthetic
example and does not provision these tables or serve GraphQL from the memory demo.

```ts
import { createGraphqlClient } from "./generated/graphql";

const queries = createGraphqlClient({
  url: projectUrl,
  publishableKey,
  getAccessToken: async () => {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    return data.session?.access_token;
  },
});
const result = await queries.ReviewList({ first: 20 });
```

The generated client has no GraphQL/compiler runtime dependency. It resolves the
current token per request, accepts an AbortSignal as the second method argument,
and rejects HTTP failures, GraphQL errors (including partial results), and malformed
envelopes. `getSdk(requester)` is available for applications with an existing
transport. Types describe the snapshot contract; response field values are
validated by generated operation parsers before either `createGraphqlClient` or
`getSdk` returns typed data. The SDK requester returns `Promise<unknown>`; it no
longer needs to claim an unchecked generic result. Standalone
`parse<OperationName>Query` and `is<OperationName>Query` functions are exported for
other boundaries. They share the standard Codegen operation types as their source
of truth and require no runtime dependency or customer code generator.
Default ID inputs are strings; unmapped custom scalars are unknown. Scalar domain
formats, authorization and remote schema freshness remain separate checks.
Unsupported non-JSON scalar mappings fail compilation instead of generating an
unchecked validator.

`graphql.manifest.json` records schema hash, query names and source locations
without timestamps. Module context packs include colocated query inventory and
the schema path. Shared fragments remain ordinary source files; review their
dependencies alongside the consuming query. Schema and query edits, additions
and deletions invalidate the incremental contract snapshot. A schema outside
`root` is watched too. `check` compares generated output without writing.

## Security and Deployment

The starter's default is a development contract, not a deployment operation.
Enabling `pg_graphql`, reviewing role grants, enforcing RLS, applying migrations,
and testing authenticated access remain explicit deployment gates. Keep production
introspection off when not needed. Use a representative role snapshot and refresh
it after schema or grant changes; compilation cannot detect an unrefreshed remote
schema or prove row-level policy correctness.

Measure actual query cost and enforce server-side resource limits before exposing
the endpoint. A query can call database functions, and a read-only generated client
cannot prevent a caller from sending a handcrafted mutation. Deny such writes at
the database boundary. This feature does not replace PostgREST, transactional
Command execution, audit or application business invariants.

For reproducible real-database tests and a synthetic relational detail page,
see [GraphQL Acceptance Pilot](graphql-pilot.md).

## Acceptance Criteria

```gherkin
Scenario: Preconfigure typed queries for new applications
  Given a new App starter with a local schema and named query
  When the application is compiled
  Then operation-specific input and result types and a callable client are generated
  And no GraphQL runtime dependency is required by the generated browser code

Scenario: Preserve existing project workflows
  Given an existing REST or Command project without GraphQL configuration or schema
  When the application is compiled and checked
  Then no GraphQL schema or query is required
  And no GraphQL client is generated

Scenario Outline: Enforce adopted contracts without overwriting working artifacts
  Given GraphQL configuration and previously generated artifacts
  When a query contains <violation> and ordinary strict mode is disabled
  Then compilation fails with a file and line diagnostic
  And the previous artifacts remain unchanged

  Examples:
    | violation                   |
    | a missing field             |
    | an incompatible variable    |
    | a business mutation         |

Scenario: Detect changes offline
  Given query contracts enabled in project configuration
  When a schema or query changes
  Then dev recompiles and check detects stale generated artifacts
  And compile and check make no network requests

Scenario: Use current caller identity and fail on request errors
  Given a generated query client with a token provider
  When consecutive requests run with different current tokens
  Then each request carries its current token
  And HTTP failures, GraphQL errors and malformed envelopes reject the request
```
