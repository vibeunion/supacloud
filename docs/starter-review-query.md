# Starter Review Query

The command starter now emits `src/review/list-reviews.ts`. It reuses a
user-scoped Supabase client, selects a Drizzle-derived read projection, validates
one-based pagination, sorts by the primary key, and preserves PostgREST errors.
It does not introduce a controller, session store or authorization wrapper.

## Acceptance

- Given a user-scoped client, when a valid page is requested, then the request
  selects only the summary columns with deterministic ordering and an exact count.
- Given invalid pagination or a previously cancelled signal, when the helper is
  called, then it fails before issuing a network request.
- Given native or mapped identity claims, when PostgreSQL evaluates the existing
  starter policies, then only the enabled authorized owner's rows are visible;
  revoked membership, mismatched identity and absent claims expose no rows.
- Given a PostgREST failure, when the helper runs, then it rejects with that error,
  rather than returning an empty successful page.
- Given a successful HTTP response with a non-array page, an invalid exact count,
  too many rows, or rows beyond the reported total, when the helper runs, then it
  rejects instead of returning an untrusted page envelope.
- Given a source field type change, when the generated query is typechecked,
  then its inferred response follows the source without editing generated types.

## Adoption And Boundaries

Existing applications may copy the maintained query source into their business
module and use their existing user-scoped client, typed with
`ReviewReadDatabase`. This is a narrow read projection, not a second database
schema: its fields come from `ReviewRow`. SQL names and Drizzle property names
must be explicitly mapped when they differ. Writes remain governed Commands.

No migration is added or rewritten. The existing starter migration 003 must
already provide the reviewed grants, `storage_subject` identity mapping and RLS.
Do not use a service-role client: TypeScript cannot prove which credentials a
client holds. JWT verification remains the gateway's responsibility; the helper
does not accept an owner ID or treat local session decoding as verification.

Exact counts and offset pagination are intended for this bounded starter list,
not a large-table query plan or snapshot guarantee. A user may see changed pages
across requests. Missing counts fail explicitly rather than guessing a total.
The helper validates the response envelope at runtime, but deliberately does not
duplicate every row field validator; row shape remains the responsibility of the
typed projection and the database/API contract.

Local tests validate the actual generated helper using the Supabase client's
HTTP transport and test existing policies separately in disposable PostgreSQL.
Those tests do not prove JWT verification by a real PostgREST deployment,
production schema parity, publication, or xigu-fa adoption.

With the `packages/db` and `packages/supacloud-js` dependencies installed, run
this single test file from `packages/supacloud-js`:

```sh
SUPACLOUD_STARTER_POSTGRES_BIN=/opt/homebrew/bin \
SUPACLOUD_REQUIRE_RUNTIME_SAFETY=1 \
bun --no-env-file test src/starter-review-query.test.ts --timeout 30000
```

Use the local PostgreSQL binary directory for the selected machine. The harness
creates and removes its own loopback cluster; it does not accept an existing
database URL. Without the binary setting, database scenarios are skipped unless
the required-safety flag is set, in which case the test fails.
