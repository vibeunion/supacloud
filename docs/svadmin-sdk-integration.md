# svadmin and the SupaCloud JS SDK

## Ownership

Keep the existing `@svadmin/supabase` adapters. Do not replace the Supabase client,
introduce a frontend DI container, or route ordinary CRUD through service-role
command RPCs.

| Responsibility | Owner / entrypoint |
| --- | --- |
| CRUD, authentication and database realtime | Supabase client and existing svadmin providers |
| Platform tasks | `@supacloud/js` and `@svadmin/supabase/supacloud` |
| Browser business-command composition | `@supacloud/js/contracts` |
| Svelte command lifetime | Optional `@supacloud/app-svelte` |
| Public operation types and validators | SupaCloud compiler and application contracts |
| Domain authorization, idempotency and receipts | Trusted application server / database |
| Query invalidation, form layout and notifications | svadmin / application UI |

For a framework-level reference that keeps this ownership model, including
request-scoped SupaCloud clients, read-only SSR snapshots and SPA task centers,
see [SvelteKit Integration](./sveltekit-integration.md). It is a transport and
lifecycle recipe, not a default SvelteKit host.

`@supacloud/js/contracts` is a facade over the existing
`@supacloud/contracts/client`, not another implementation. It is separate from the
SDK root and does not expose platform commands or persistent browser locks.
Existing direct contract imports remain valid. Applications needing durable locks
can explicitly install and import `@supacloud/contracts/browser`.

## Compose a business action

The following is an integration pattern, not a claim that the compiler currently
generates a complete svadmin action. `approvalContract` and `approvalApi` are
application-owned: the contract supplies input, acknowledgement and authoritative
result decoders plus request/entity/operation matching. The API calls fixed,
trusted application endpoints with the current authenticated session.

```svelte
<script lang="ts">
  import { createAuthoritativeCommandClient } from "@supacloud/js/contracts";
  import { createSvelteCommandScope } from "@supacloud/app-svelte";
  import { approvalContract, approvalApi, approvalTarget } from "./approval";

  // approvalTarget is a Readable key containing tenant, actor and order identity.
  const scope = createSvelteCommandScope({ target: approvalTarget });
  let status = $state("idle");

  async function approve(input: Parameters<typeof approvalApi.send>[0]) {
    const attempt = scope.begin(input.operationId);
    const execute = createAuthoritativeCommandClient(approvalContract, {
      send: (value) => approvalApi.send(value, attempt.signal),
      lookup: (value) => approvalApi.lookup(value, attempt.signal),
    });
    const outcome = await execute(input);
    attempt.commit(() => { status = outcome.status; });
  }
</script>
```

Generate/persist the operation identifier before sending, according to the
application's recovery policy. Pass the captured identity/target into both calls;
do not silently switch a pending command to a newly selected tenant.
Disable duplicate submissions while the operation is unresolved. A command scope
prevents stale view updates; it is not a server-side lock or idempotency mechanism.

Only a `confirmed` outcome carries authoritative data. Map `invalid` to input
feedback, `denied` to a definitive application rejection, and `unknown` to a
pending-confirmation/recovery UI. A returned acknowledgement is not necessarily
the final business result. The default confirmation mode performs one read-only
lookup even after a valid acknowledgement. Do not wrap this action in a generic
mutation retry policy or collapse its outcomes into a successful `{ data }`.

`createAuthenticatedFetch` is also available through the optional entrypoint. It
obtains a token before sending over HTTPS and never refreshes/replays after 401.
Its supplied transport must itself be single-attempt, and its destination must be
a fixed trusted origin. For SvelteKit, obtain request-specific credentials through
the host context rather than storing user sessions in module-level singletons.

Unmounting, target changes and navigation must invalidate pending view updates.
`@supacloud/app-svelte` handles destruction and explicit target/router bindings;
see its README for `onNavigate`. Cancellation does not prove server rollback and
must not clear a persisted unresolved operation. Refresh affected queries only
after confirmation and while the original tenant/actor still owns that cache.

## Bind the generated review reference

The command starter emits `src/client/reviews.ts` and
`src/client/review-transport.ts`. Bind these to the existing SVAdmin view/store;
no SVAdmin dependency is added to the generated application.

```ts
import { createAuthenticatedFetch } from "@supacloud/js/contracts";
import { createReviewClient, createReviewPendingStore } from "./client/reviews";
import { createReviewTransport } from "./client/review-transport";

// Run inside a mounted, identity-scoped view, never a server module singleton.
const pending = createReviewPendingStore(localStorage, {
  projectId: session.projectId,
  tenantId: session.tenantId,
  applicationId: "reviews",
  subject: session.subject,
});
const client = createReviewClient(createReviewTransport({
  supabase: session.supabase,
  apiOrigin: applicationOrigin,
  authenticatedFetch: createAuthenticatedFetch({
    getAccessToken: () => session.getAccessToken(),
  }),
}), pending);
const unsubscribe = client.subscribe(() => updateView(client.snapshot()));
updateView(client.snapshot());
void client.load();

// Register this with the view's unmount and identity-change lifecycle.
function dispose() {
  unsubscribe();
  client.dispose();
}
```

Here `session`, `applicationOrigin` and `updateView` are application-owned
bindings, not new SDK globals. Capture one immutable session identity. Its token
supplier must refuse a switched identity, and its Supabase instance must not
silently adopt another actor's token. Dispose and reconstruct the view on
project, tenant or subject change; never just change credentials in place.

Bind rows and read feedback to `state.list`; bind approval/upload buttons to
`client.approve(row)` / `client.upload(row, file)`. Disable mutations while
submitting or unknown, and expose `client.reconcile()` separately. Recovery reads
the original authorized operation receipt, not the current row state. Do not
wrap these calls in an SVAdmin mutation retry hook. Only confirmed results may
invalidate other affected queries, and only while their original scope is active.

The reference pending store survives reload but is not an atomic cross-tab
lock. Keep one active mutation owner per identity/application. Logout and
unmount must not delete unknown operations. Stored pending data contains no
tokens, business rows or file bytes; storage corruption blocks writes.

See [customer workflow acceptance](customer-workflow-completion.md#browser-acceptance)
for the reproducible browser-to-native-database fixture. Its optional `--svadmin`
view uses installed SVAdmin Button/Table components, Svelte subscriptions and
unmount cleanup. On October 16, 2026 that view passed the same real-database
upload, approval, conflict, reload-recovery and foreign-identity scenarios as
the DOM view, with strict Svelte diagnostics enabled. This verifies those
components and the reference binding, not every SVAdmin provider or the deployed
customer UI. Neither the template nor the SDK gains a hard UI dependency.

## Task adapter compatibility

The `@svadmin/supabase` task subpath declares `@supacloud/js` as an optional peer
with the tested range `^0.33.0 || ^0.34.0 || ^0.36.0`. Its consumer fixtures run
against those three released SDK lines. At the time of writing, the upstream
`packages/supacloud-js` source tree is `0.45.3`, so source is ahead of the
declared peer range; do not treat the repository version as an adapter
compatibility claim.

A `0.45.3` transport probe passes against the task endpoints, but that line
requires `@supabase/supabase-js` 2.118.0 and its nested auth-js types currently
fail the strict consumer type check. Do not widen the peer range until the
auth-js patch and type matrix are updated.

Adding a new SDK line requires updating the peer range and rerunning the real
SDK-backed fixtures for submit, metadata, wait, list, cancellation, retry,
subscription delivery and cleanup. CRUD/auth providers need not change.

The SDK defaults task subscriptions to Management API polling. Realtime requires
an explicitly published application-owned table; do not assume an internal
`public.tasks` table exists.

## Next integration steps

### Studio Auth form coverage

The project Auth page's create-user and invite-user forms now consume a
browser-only copy of the Management API's pure auth mutation schemas.
`node scripts/generate-auth-user-contract.mjs` regenerates that file;
`--check` checks it without writing. The focused web-console test also compares
the source and generated contract, so schema drift fails CI.

The route handlers use the same input schemas and validate successful GoTrue
responses. The form client derives its input types from an explicit writable
subset (not the user record), rejects extra fields before sending, and validates
the result before triggering success feedback. The existing Studio cookie
transport is retained; mutations have no automatic retry. A captured project
scope prevents late results from refreshing a different project's table.
Cancellation does not prove rollback of a dispatched write.
SVAdmin's native `parseContractCreateInput` snapshots both forms before dispatch
and rejects accessors and serialization hooks. Mutation receipts expose only
the closed public user record (`id`, optional `email` and `phone`).

Acceptance scenarios:

- Given a create or invite form, when it submits valid input, then its fixed
  tenant route receives one request and the result has a validated string ID.
- Given missing or incorrectly typed fields, when the consumer is compiled or
  untyped input is submitted, then it fails before the transport is called.
- Given a malformed successful response or an API failure, when the response
  arrives, then the form client rejects it and does not retry the write.
- Given a pending mutation, when the project changes or the page is destroyed,
  then the old scope is cancelled and its callbacks cannot refresh the new view.

This is coverage of two specific routes, not all Management API business routes
or all Studio forms. Dynamic table writes remain disabled. Other forms, generic
SVAdmin mutation contracts, and automatic full-route client generation remain
separate work. No upstream SVAdmin change or SDK release is required here.

### Studio Auth URL configuration

The URL configuration form derives writable inputs from the Management API's
pure schema and uses a generated copy of its URL validator. Regenerate both with
`node scripts/generate-auth-url-config-contract.mjs`; `--check` detects drift.
SVAdmin snapshots the closed input before normalization. A local singleton record
ID is never transmitted. Reads accept existing uppercase aliases, project only
URL fields, and reject malformed field types. Writes require a canonical receipt
whose URL strings exactly match the normalized request.

The generic Auth PATCH route deliberately retains its existing validation and
structured 400 responses; this is not whole-route static type inference.
The form uses a dedicated query key, disables mutation retries, and cancels
captured scopes so late A-to-B-to-A completions cannot alter the current draft.
Cancellation still does not imply server rollback.

Focused verification:

```sh
# From packages/web-console
bun test 'src/routes/project/[ref]/auth/url-configuration/page.test.ts'
# From packages/management-api
bun test tests/unit/auth-config-boundary.routes.test.ts
# From repository root
node scripts/generate-auth-url-config-contract.mjs --check
```

These tests cover input/result types, schema drift, malformed receipts, exact
payloads, credentials, duplicate submission, retry suppression and stale scope
completion. The compiled Svelte page uses mocked HTTP; backend route tests run
separately. This is not a browser-to-live-backend or production acceptance claim.
SMTP, hooks and other unrelated forms remain outside this scoped migration.

### Web Console upgrade baseline

The Web Console tracks this published SVAdmin line, verified on November 1, 2026:

- `@svadmin/core` `0.69.2`
- `@svadmin/ui` `0.108.2`
- `@svadmin/elysia` `0.14.19`
- `@svadmin/sveltekit` `0.13.16`
- `@svadmin/ai-elements` `0.13.4`

List and settings pages that repeated a local loading, empty, and error shell now
use `PagePattern`. Pages with a client-side search use `FilterToolbar`. The
Management API requests and mutation payloads are unchanged.

The application runtime page uses `PagePattern`, `Input`, `DataState`,
`DescriptionList` and the SVAdmin table primitives. Operators still choose an
application and environment, inspect independently loaded runtime/release data,
and open the corresponding development snapshot. The scope form remains visible
when no application is selected. Each section owns its loading, empty and error
state; a failed runtime read must not hide available releases. Read failures offer
the existing refresh action. Preview creation and cleanup keep their explicit
buttons and single-attempt requests.

Acceptance scenarios for this migration:

```gherkin
Scenario: Choose an application scope
  Given no application or environment is selected
  When the operator opens the application runtime page
  Then the SVAdmin scope inputs remain available beside the empty state
  And submitting a valid scope updates the URL and loads that scope

Scenario: Independent sections and recovery
  Given application data is loading
  When the runtime read fails but releases load successfully
  Then the runtime section offers retry and the releases remain usable
  And retry refreshes reads without repeating a preview mutation

Scenario: Release and development navigation
  Given multiple release pages and a stored development snapshot
  When the operator changes release pages or inspects a target
  Then pagination and the verified development details remain available
  And an empty release page displays the SVAdmin empty state

Scenario: Scope changes and unmount
  Given a request is pending for the current project and application
  When the operator switches scope or leaves the page
  Then the request is cancelled and late data cannot replace the current view
```

`@supacloud/app` is the source package in this repository, currently `0.34.1`.
Its `file:../contracts` dependency stays linked to the local contracts package;
upgrading its Angular development pair does not replace it with a registry copy.
The Svelte binding retains TypeScript 6 for `svelte-check`, as does the Console
alongside its TypeScript 7 alias.

The November 1 refresh was verified with frozen installs for the three changed
packages, registry/outdated checks and the single compiled DOM fixture below.
Its mocked HTTP scenarios cover the acceptance criteria above, including form
validation and duplicate preview submission suppression. It does not verify a
deployed backend or authenticated browser session.

```sh
# From packages/web-console
bun test 'src/routes/project/[ref]/applications/page.test.ts'
```

This release line requires SvelteKit 3, so the Console also migrated its
adapter configuration into the Vite `sveltekit` plugin and moved page state
consumers from `$app/stores` to `$app/state`. The legacy TypeBox 0.34 marker
bridge was removed because SVAdmin now consumes TypeBox 1.x directly.
Fixed schemas use the strict `defineResource` entrypoint; only schemas built
from live database column metadata retain a separate dynamic boundary.
`bun run check` and `bun run build` remain release gates and were not rerun for
this focused migration. The latter may still
report existing bundle-size and ineffective dynamic-import warnings.

Earlier baseline Chromium acceptance used mocked HTTP responses, not production data:
the Auth user list rendered, a valid create submission closed the form and
showed success, and an invite response with a numeric ID retained the draft
and showed failure. These checks are not deployment or live backend acceptance.

1. Export browser-safe public operation contracts and generated clients without
   server implementation imports. Do not derive writable fields from table shape.
2. Bind those artifacts to existing svadmin resource/command contracts. Their
   schema subsets, result envelopes and acknowledgement semantics must agree;
   fail unsupported mappings rather than casting types.
3. Reuse the existing query cache. Declare affected resources explicitly for
   business operations; do not infer invalidation from a method's name.
4. Add one end-to-end list/edit/approve fixture covering field errors, unknown
   outcomes, target switching and late results. Keep UI metadata application-owned.

This PR delivers the SDK facade, public-entrypoint consumer/type checks and browser
bundle isolation.

## End-to-End Vibe Coding Schema Generation

With the `database` MCP compound tool in `@supacloud/cli`, AI agents and operators can now directly export database column metadata into `@svadmin/core` compatible schema definitions without human transcription:

```sh
# Via MCP tool call:
database action="export_svadmin_schema" table="orders" json=true
```

The resulting `databaseColumns` payload connects directly to `svadmin_generateResource`:

```ts
svadmin_generateResource({
  resource: "orders",
  sourceType: "databaseColumns",
  payload: JSON.stringify(exportedColumns),
});
```

This guarantees zero-hallucination type alignment across:
PostgreSQL Table $\longrightarrow$ SupaCloud CLI Metadata $\longrightarrow$ svadmin ResourceDefinition $\longrightarrow$ Svelte 5 AutoTable / AutoForm.

## Local verification

From `packages/supacloud-js`:

```sh
bun run ../../scripts/build-command-dependencies.ts supacloud-js
bun install --frozen-lockfile
bun run typecheck
bun run typecheck:test
bun run build
bun run typecheck:consumer
bun test
```

The consumer fixture resolves `@supacloud/js/contracts` through the package export
map, not a TypeScript source alias. Its browser bundle must exclude the platform
SDK and Supabase/Angular/Svelte dependencies. Deterministic command tests cover
single-attempt confirmation, invalid input, mismatched authority and stale scope
commits. These are local contracts, not production or publication acceptance.
