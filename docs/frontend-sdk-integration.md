# Frontend SDK Integration

## One Session, Explicit Owners

`@supacloud/js` is the SupaCloud platform SDK for frontend and server consumers.
It wraps, rather than replaces, the application's Supabase client. A frontend
should not assemble a second authentication system to call a business endpoint.

| Responsibility | Owner |
| --- | --- |
| User session, database CRUD, Storage and Realtime | Existing `@supabase/supabase-js` client, also exposed as `supacloud.supabase` |
| SupaCloud task receipts, status and authorized task actions | `@supacloud/js` |
| Business-specific HTTP/query types and response validation | Compiler-generated application clients |
| Authenticated business-command transport and confirmation composition | `@supacloud/js/contracts`, reusing `@supacloud/contracts/client` |
| Routing, forms, query cache and UI state | Selected frontend framework or svadmin |
| Domain authorization, transactions, idempotency and audit | Trusted application server and database |

Existing Supabase and svadmin providers remain valid. There is no requirement to
replace CRUD with Commands, introduce frontend DI, or migrate existing reads to
GraphQL. The starter's query choice does not change the SDK's ownership boundary.

## Compose Existing Clients

Create the Supabase client once in browser application setup. The URLs below are
fixed application configuration, never input from a user, query string or task
payload. Use public project keys only. The Management API URL is a destination,
not a request for an administrator token: use only task endpoints that authorize
the current user, and leave operator APIs on a trusted server.

```ts
import { createClient } from "@supabase/supabase-js";
import { createSupaCloudClient } from "@supacloud/js";
import { createAuthenticatedFetch } from "@supacloud/js/contracts";
import { createApiClient } from "./generated/client";

const supabase = createClient("https://project.example.com", "publishable-key");

const getAccessToken = async (): Promise<string | null> => {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session?.access_token ?? null;
};

const supacloud = createSupaCloudClient({
  supabase,
  managementApiUrl: "https://management.example.com",
  projectRef: "project-ref",
  getAccessToken,
});

const api = createApiClient({
  baseUrl: "https://app.example.com/api",
  fetch: createAuthenticatedFetch({ getAccessToken }),
});

export { supabase, supacloud, api, getAccessToken };
```

The generated client accepts a standard fetch function without Bun-specific
static properties. Existing native fetch implementations remain valid.
No additional SDK constructor, transport implementation or runtime engine is
introduced. Applications retain generated operation types and response checks.

When GraphQL is enabled, pass the same `getAccessToken` to `createGraphqlClient`
alongside the fixed project URL and public key. Do not capture an access token
at startup. Anonymous query support, where intended, remains governed by
database grants and RLS; it is distinct from the authenticated command transport.

For background submission, configure the existing `createSupaCloudTaskFetch`
guard when creating the same Supabase client, as described in the
[SDK guide](../packages/supacloud-js/README.md#quick-start). This recipe does not
implicitly install function transport guards.

In SSR, create these clients per request using that request's credentials.
Never put a user's session into a shared server singleton. A session read in the
browser is not server identity verification; the trusted host verifies tokens
and resolves current application access.

## Failure And Trust Boundaries

- `createAuthenticatedFetch` resolves credentials before each send. No current
  token means no request; a refreshed token is used by the next request.
- It requires HTTPS, rejects redirects, and sends once. It does not refresh and
  replay after 401. Supplied transports and interceptors must not retry writes.
- It is not an origin allowlist. Keep `baseUrl` and routes trusted; never use its
  low-level request method to send credentials to caller-selected destinations.
- An HTTP error, cancellation or lost response does not prove rollback. Use an
  application-owned operation ID and authoritative receipt to resolve uncertainty.
  `createAuthoritativeCommandClient` composes send/lookup without replaying writes.
- Tenant/actor changes must invalidate pending view updates and cache ownership.
  Sharing a token resolver alone does not implement this lifecycle.
- `supacloud.commands` and `supacloud.workflows` call service-role-only RPCs.
  They are not browser business-action APIs. Privileged queue, artifact and OAuth
  operations also require their documented server/operator boundary.
- Exported methods and SDK types do not enforce authorization. Every backend
  endpoint must enforce its own user, project and object access rules.

See [svadmin integration](./svadmin-sdk-integration.md) for command lifetime,
cache invalidation and authoritative confirmation.

## Acceptance

```gherkin
Scenario: Reuse the existing session
  Given a user-scoped Supabase client and one current-token resolver
  When the platform SDK and a generated business client are composed
  Then the SDK retains that Supabase client
  And both clients use the same resolver without a second session store

Scenario: Reflect session changes before sending
  Given a composed authenticated business client
  When its session token changes or the user signs out
  Then the next request uses the new token or fails before network dispatch

Scenario: Do not replay an uncertain write
  Given a business write receives HTTP 401 or loses its response
  When the generated client reports the failure
  Then the transport has sent at most once
  And the client has not inferred that the transaction rolled back
```

Focused verification (requires installed compiler/SDK dependencies and built
shared contracts and SDK public entrypoints, as in the existing package setup):

```sh
bun test scripts/frontend-sdk.test.ts
```

These are synthetic local transport and generated-client tests. They do not
attest live SupAuth sessions, task endpoint authorization, database transactions,
publication or deployment. Existing frontend APIs are not removed by this change.
