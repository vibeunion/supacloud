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

## Compatibility before upgrading the task adapter

At the integration baseline, svadmin pins SDK `0.23.1` for tests and declares
`^0.23.1` as an optional peer; SupaCloud source is `0.33.0`. Those ranges do not
overlap. This new subpath is not available in the old SDK. Do not widen the peer
range or update installation instructions until a released SDK containing it has
passed the adapter's consumer tests.

In particular, the current SDK defaults task subscriptions to Management API
polling. Realtime requires an explicitly published application-owned table; do
not assume an internal `public.tasks` table exists. Re-run the real SDK-backed
svadmin fixtures for submit, metadata, wait, list, cancellation, retry, subscription
delivery and cleanup when upgrading. CRUD/auth providers need not change.

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

### Web Console upgrade baseline

The Web Console currently tracks the published SVAdmin line:

- `@svadmin/core` `0.59.0`
- `@svadmin/ui` `0.82.0`
- `@svadmin/elysia` `0.14.3`
- `@svadmin/sveltekit` `0.13.0`
- `@svadmin/ai-elements` `0.11.0`

This release line requires SvelteKit 3, so the Console also migrated its
adapter configuration into the Vite `sveltekit` plugin and moved page state
consumers from `$app/stores` to `$app/state`. The legacy TypeBox 0.34 marker
bridge was removed because SVAdmin now consumes TypeBox 1.x directly.
Fixed schemas use the strict `defineResource` entrypoint; only schemas built
from live database column metadata retain a separate dynamic boundary.
`bun run check` and `bun run build` are the upgrade gates; the latter may still
report existing bundle-size and ineffective dynamic-import warnings.

Local Chromium acceptance used mocked HTTP responses, not production data:
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
bundle isolation. It does not deliver automatic svadmin schema generation, a
svadmin SDK upgrade, a production authorization integration or a release.

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
