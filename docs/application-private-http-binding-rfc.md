# RFC: Private HTTP bindings for Application Delivery

Status: **Proposed**. No runtime behavior or supported configuration changes.

## Problem

A project may keep an Edge Function as its public API while moving database-backed
commands to a managed Bun Application. The Function needs a stable address for
the trusted host, but activation allocates a new loopback port and both the
[configuration contract](../packages/delivery/src/application-configuration.ts)
and [gateway builder](../packages/management-api/src/services/application-gateway.ts)
require a hostname for HTTP targets. A DNS name on the public gateway is not
caller authorization. A hardcoded loopback port is not a release binding.
The [developer invocation tool](application-development-context.md) is a
non-production GET/HEAD inspection tool, not a credential-forwarding data plane.

## Proposed contract

- Add an explicit private ingress mode for an HTTP target. Existing hostname
  targets retain their behavior. A private target cannot declare public hosts and
  must not create a public gateway route, even in a release with public targets.
- Bind a named caller capability to an exact project, environment, Edge Function
  slug, Application and HTTP target in reviewed configuration. The Edge Runtime
  uses dispatch authority, not caller-supplied headers, to attest the calling
  project and Function. Consider the request-scoped
  [Pgredis binding](../packages/edge-runtime/internal-bindings.ts) as a lifecycle
  pattern; do not reuse its credentials or add access to default capabilities.
- Resolve the binding server-side through committed activation authority and
  the verified runtime allocation. Do not take a destination URL, host, port or
  project routing key from the forwarded request. The broker must use a separate
  authenticated internal transport, not a Management API token or public route.
  Bound method/path, payload, redirect behavior and timeout at this boundary.
- Keep the business identity separate from the caller capability. Forward
  only the explicitly supported headers, including the user's authorization
  and idempotency key for governed commands. Never expose the capability to the
  browser, application handler, or logs. The host still decides application
  access and owns transaction, receipt and audit.
- Resolve the existing binding after activation or rollback without redeploying
  the Function or leaking the allocated port. Do not route to an uncommitted or
  mismatched runtime. Return a sanitized unavailable result when the active
  target is down. No automatic replay of writes and no zero-downtime guarantee.

The first implementation should cover one same-project Edge Function caller
type. Cross-project trust, general-purpose service discovery, public private
gateways, and changes to business authorization are out of scope.

## Acceptance

```gherkin
Scenario: A private target cannot be reached through the public gateway
  Given a release with one private and one hostname-based HTTP target
  When its activation is verified
  Then only the hostname-based target has a public route

Scenario: Only the bound Function can invoke the target
  Given a private binding for a Function in one project and environment
  When an unbound Function or a different project presents a request
  Then it is rejected before any request reaches the application

Scenario: Caller authority does not replace business authorization
  Given the bound Function invokes a private command
  When the forwarded user has insufficient permissions
  Then the host rejects the command and records no business write

Scenario: Promotion and rollback keep a stable binding
  Given a binding for a committed healthy activation
  When a candidate is activated or a verified rollback is committed
  Then the same binding resolves to the new committed runtime
  And an uncommitted or failed candidate never receives traffic

Scenario: An uncertain write is not replayed
  Given a private write request times out after forwarding
  When the transport reports the failure
  Then it does not resend the write, follow a redirect, or try a different target
```
