# Project GraphQL Enablement

## Purpose And Boundaries

An operator enabling `pg_graphql` must get a callable, role-scoped
`graphql_public.graphql` entrypoint, not only a row in `pg_extension`.
This repair supports selective typed GraphQL reads; it does not migrate all APIs
to GraphQL or use performance as an adoption criterion.

`pg_graphql` remains opt-in. The repair does not install host packages, grant
table access, alter RLS, enable introspection, expose the internal `graphql`
schema through PostgREST, or change application commands.

## Enable Or Repair

Check availability in the intended project database:

```sql
SELECT name, default_version, installed_version
FROM pg_available_extensions WHERE name = 'pg_graphql';
```

A row with a null `installed_version` means the package is available but the
project has not enabled it. The historical fallback's "not installed on the host
cluster" message does not distinguish those states.

After deploying a Management API release containing this fix, call the existing
project-scoped route with authorized operator credentials:

```http
POST /v1/projects/:ref/extensions/enable
Content-Type: application/json

{"extension":"pg_graphql"}
```

The alternative `POST /v1/projects/:ref/extensions/` accepts
`{"name":"pg_graphql","version":"1.6.1"}` when that version is available.
Credentials stay in a trusted operator/server context, never application browser
code. Existing authentication, project matching and capability checks still apply.
No project is automatically enabled merely by upgrading the platform.

One transaction installs the extension, reconciles the four-argument forwarding
function, validates the installed state and sends project/global PostgREST schema
reload notifications. Repeating the operation repairs an already-installed
project with a missing entrypoint.

The canonical wrapper is `VOLATILE SECURITY INVOKER`, uses the caller's search
path for schema reflection, and forwards all four arguments to the qualified
`graphql.resolve` function. New wrappers grant execution to the standard API
roles. Existing four-argument wrappers retain their identity, owner, dependencies
and explicit execution grants; their body is reconciled to the canonical
forwarder. Three-argument wrappers migrate explicit execution grants and grant
options, then disappear to avoid PostgREST overload ambiguity. In both cases,
PUBLIC execution is revoked, and new-wrapper default grants are removed before
applying the intended explicit grants. Necessary schema usage and resolver execution are
granted only to named wrapper execution grantees.

Removing a legacy overload never uses `CASCADE`. Dependent application objects,
incompatible existing signatures, unavailable extension versions, or grant
failures abort the transaction. The prior extension/function state survives;
the operator must resolve the specific conflict before retrying.

This guarantee applies to the enablement transaction. Existing tenant bootstrap
and reconciliation paths may independently regrant standard-role wrapper access;
this change does not establish permanent service-role-only endpoint policy.
Application table grants and RLS remain the authorization boundary.

## Acceptance

```gherkin
Scenario: First project enablement
  Given a project has the standard fallback and the host package is available
  When the Management extension service enables pg_graphql
  Then an already-running PostgREST instance resolves the real GraphQL RPC
  And another project remains unchanged

Scenario: Caller authorization
  Given two JWT subjects and row-level read policies
  When each subject queries the same GraphQL collection over HTTP
  Then only its own rows are returned
  And anonymous and ungranted-table access are denied
  And the internal graphql schema remains unavailable as a REST profile

Scenario: Repeat and legacy repair
  Given an already-installed extension or a legacy three-argument wrapper
  When enablement runs again
  Then a single four-argument invoker entrypoint exists
  And restricted explicit execution grants are not widened
  And existing four-argument dependencies survive

Scenario: Atomic failure
  Given a grant failure, a dependent legacy wrapper or an unavailable version
  When enablement cannot complete
  Then the old fallback and dependent objects remain
  And a newly-created extension is rolled back
  And no successful enablement response is fabricated
```

## Local Verification

Prepare the same images used by the GraphQL pilot (the test never pulls images):

```sh
docker build -t supacloud-graphql-test:pg18 docker/graphql-test
docker pull postgrest/postgrest:v16.2
cd packages/management-api
bun install --frozen-lockfile
bun test tests/unit/extension.service.test.ts
bun test tests/unit/extensions.routes.test.ts
bun run typecheck
bun run typecheck:graphql-tests
bun run test:graphql-local
```

The focused test configuration uses `strict` and checks dependency declarations
with `skipLibCheck: false`. Enabling all additional indexed-access and exact
optional-property checks across its transitive imports currently reports 31
existing diagnostics in `config.ts`, `db/index.ts` and `db/sql-query-registry.ts`.
None are in the changed GraphQL code or tests; that separate migration is not
included or hidden by this fix.

The opt-in test runs alone and calls the real `ExtensionService.enableExtension`
and real database mapping. Its disposable PostgreSQL databases contain synthetic
projects; no remote URL is accepted. PostgreSQL and HTTP ports bind to loopback.
The helper starts PostgREST without installing a wrapper, and exercises
`/rpc/graphql` with the `graphql_public` profile used by `/graphql/v1`.
It does not launch the platform gateway or claim deployed Management HTTP-route
acceptance. JWT validation, database roles, RLS, function execution, transactions
and live schema reloads are real. Resources are removed on normal completion.

Deployment acceptance remains separate: verify the published release contains the
fix, upgrade the authorized environment, explicitly enable/repair the project,
then test `/graphql/v1` with intended application credentials and generated query
contracts. No production or test-environment deployment is performed by this
local suite.
