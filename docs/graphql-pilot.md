# GraphQL Acceptance Pilot

## Scope

This pilot runs a real PostgreSQL + pg_graphql + PostgREST stack in isolated
local Docker containers with synthetic order data. It does not connect to an
existing project, alter a shared cluster, or deploy a production application.
The read-only order detail includes a customer, line items and deliveries.

The migration/contract gate is explicit:

1. Apply the application-owned migration in its selected test environment.
2. Run `graphql-schema --check` with the intended caller's credentials.
3. If drift is reported, export the updated snapshot and run compile/check/typecheck.
4. Pass role/RLS and query-cost acceptance before promotion.

Compilation remains offline. This gate does not enable production introspection.

## Run Locally

Prerequisites: Bun, Docker, and installed compiler dependencies. From the repository:

```sh
docker build -t supacloud-graphql-test:pg18 docker/graphql-test
docker pull postgrest/postgrest:v16.2
bun run scripts/check_graphql_pilot.ts
# Run the same acceptance suite and retain the local page until Ctrl-C:
bun run scripts/check_graphql_pilot.ts --serve
```

The runner creates uniquely named containers and a network, stores database data
on tmpfs, binds HTTP only to loopback, and removes its own resources when the suite
finishes or when a ready `--serve` process receives Ctrl-C/SIGTERM. Forced kills or
host failures can leave resources behind; identify them by the
`supacloud.graphql-pilot` container label before removing them.
The Docker images remain cached. The temporary demo issues synthetic tenant tokens;
it must not be exposed as a production service or authentication implementation.
`--serve` prints the page URL. The report is written to
`output/graphql-pilot/report.json`; generated artifacts are temporary.

The fixture contains 2,001 orders, 20,001 line items and 4,000 deliveries,
including deliberately cross-linked rows to test nested RLS. It enforces
read-only grants on the caller role and tests handwritten GraphQL mutations and
REST writes, independently of compiler validation.

The latency comparison uses five warmup rounds and 30 samples per protocol,
alternating request order. Both protocols fetch the same selected fields in one
request. GraphQL p95 must remain below a local 500 ms smoke budget; that is not
a production SLA, load test, query-plan guarantee, or evidence that GraphQL is
faster. No measured developer-time saving is claimed. Real project grants,
business Commands, production-scale data, concurrency, and deployment acceptance
remain application-specific gates.

## Verification

Compiler unit tests cover rejected variables, unselected fields, typed documents,
artifact preservation, watch/incremental invalidation and Context Pack content.
The packaged starter smoke checks the installed release artifacts together:

```sh
cd packages/compiler
bun test
bun run typecheck:test
cd ../..
bun run scripts/check_app_starter.ts
```

Browser acceptance was also exercised at 1440px desktop and 390px mobile widths:
the customer, ten line items and two deliveries render; tenant switches and a
cross-linked customer cannot reveal unauthorized data; rapid switches cancel old
requests; simulated HTTP failures hide stale data and permit retry. Screenshots
are under `output/playwright/`. The database runner itself does not launch a
browser, so browser acceptance must be repeated separately after UI changes.

## Acceptance Criteria

```gherkin
Scenario: Real role-scoped contracts
  Given PostgreSQL with pg_graphql and two seeded tenants
  When anonymous and authenticated identities export their schemas
  Then protected tables and columns are absent for unauthorized roles
  And authenticated order queries execute through PostgREST JWT validation

Scenario: Read and write isolation
  Given two tenant identities and a read-only database role
  When callers attempt cross-tenant reads and handcrafted mutations
  Then no other tenant's rows are returned
  And inserts, updates and deletes are denied without changing data

Scenario: Migration detects a broken operation
  Given a valid generated order client and schema snapshot
  When a selected database column is renamed
  Then the remote schema check fails without overwriting the snapshot
  And exporting the new snapshot makes the old query fail compilation
  And the previous generated client is preserved

Scenario: Standard typed documents
  Given typedDocuments enabled
  When the compiler generates order operations
  Then a TypedDocumentNode consumer infers variables and selected results
  And incorrect variables and unselected fields fail TypeScript checks

Scenario: Inspect the actual order and query cost
  Given the seeded relational dataset
  When the detail page executes the generated query
  Then it displays the customer, line items and deliveries
  And equivalent GraphQL and REST results and latency distributions are recorded
  And a bounded local latency budget is enforced without claiming a production SLA
```
