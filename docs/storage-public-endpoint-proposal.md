# Proposal: Internal Storage and Browser Delivery Endpoints

Status: proposed design contract, not an implemented configuration option.

## Problem and Evidence

An internal S3 endpoint may be healthy for a server while unusable from a browser.
In Xigu FA, historical issues #1817, #1785, and #1828 motivated separate internal
read/write and external signing endpoints. This is consumer evidence, not proof
that SupaCloud's current Storage API emits an invalid URL.

The reviewed SupaCloud main at `e47b25bd` has distinct paths already:

- `packages/management-api/src/config.ts` defines internal `s3Endpoint`.
- `packages/management-api/src/routes/storage.ts` uses that endpoint to build
  source URLs for image processing, while public object URLs use a project API
  host.
- `packages/management-api/src/routes/storage-compat.ts` has a Storage API signed
  URL flow. It must not be conflated with direct S3 SigV4 presigning.

Consequently, globally replacing `S3_ENDPOINT`, rewriting signed URLs after
signing, or forcing direct S3 delivery would be incorrect. This PR adds no runtime
setting, signer, route, deployment change, or second object ledger.

## Proposed Contract

Keep two explicit delivery modes:

| Mode | Server transport | Browser URL authority | Authorization |
| --- | --- | --- | --- |
| Storage API (existing) | Internal S3 transport | Configured public project Storage API | Existing Storage API token and policy checks |
| Direct S3 (future opt-in) | Internal S3 transport | Separately configured public S3 signing endpoint | Existing tenant/object authorization before SigV4 signing |

For a future direct-S3 mode, an internal endpoint and a public signing endpoint
must identify the same object namespace. The final host and path must be selected
before signing; replacing a signed URL's host or prefix is forbidden.

The future public endpoint is operator-controlled configuration, never a URL
supplied by an untrusted request. It must not contain credentials, a query, or a
fragment. Production browser delivery requires HTTPS. A loopback-only internal
address without a suitable public delivery endpoint is a configuration error
when generating browser links, not a reason to disable internal server access.

Local development or private-network deployment needs an explicit policy rather
than silently weakening production checks. A hostname passing syntax validation
does not establish browser reachability, TLS validity, DNS safety, namespace
equivalence, or reverse-proxy correctness.

This proposal intentionally does not assign a new environment variable name.
Runtime ownership, per-project versus instance scope, existing public-origin
configuration, and compatibility with Silo/MinIO must be settled before adding one.

## Diagnostics and Security

A future preflight should report which delivery mode was checked and distinguish:

- Invalid endpoint configuration.
- Internal transport failure.
- Browser-facing endpoint or proxy failure.
- Signature mismatch.
- Authorized object missing.
- Access denied or expired link.

Diagnostics must not expose keys, bearer tokens, signed query strings, raw
credential-bearing URLs, or private internal hostnames to unauthorized callers.
Error messages must not suggest making a bucket public to repair delivery.

Static validation can run without network access. Any active probe must be an
explicit operator action with a bounded timeout, approved destination, and a
disposable authorized object. Redirect following and arbitrary URL probing are
not permitted by default.

## Implementation Acceptance

```gherkin
Scenario: Existing Storage API delivery
  Given a project uses the existing public Storage API endpoint
  When a browser requests an authorized signed link
  Then the Storage API URL and existing authorization semantics are preserved
  And an internal S3 endpoint is not substituted into the browser URL

Scenario: Future direct S3 delivery
  Given internal transport and public signing endpoints address the same namespace
  When an authorized browser download is signed
  Then signing uses the final public host and path
  And server reads continue to use the internal endpoint

Scenario: Loopback is not a browser destination
  Given direct S3 delivery has only a loopback internal endpoint
  When a browser link is requested
  Then delivery fails with a sanitized configuration error before emitting a URL
  And server-only storage operations remain available

Scenario: Multipart upload and link renewal
  Given a caller is authorized for a multipart upload or an expired-link renewal
  When the service creates browser part URLs or renews a download
  Then each signature uses the public endpoint and current authorization
  And multipart creation and completion use the existing internal transport

Scenario: Wrong namespace or altered proxy host
  Given endpoints disagree on the object or the proxy alters the signed host
  When an explicitly authorized preflight verifies a disposable object
  Then validation fails rather than claiming success from an HTTP health check
```

## Rollout Gate and Non-Goals

Before a runtime PR, reproduce a concrete failing delivery path on current main,
select its owning module, and prove existing Storage API behavior remains intact.
Add deterministic signer/proxy tests and record real browser upload/download
acceptance separately. No live acceptance was run for this documentation PR.

Keep direct delivery opt-in and retain existing delivery configuration for
rollback. A mode switch does not migrate buckets, rename objects, copy business
records, change tenancy, bypass RLS, or alter command receipts. A runtime rollout
must address already-issued links and in-progress multipart uploads explicitly.

FA-specific environment variables, report workflow, business authorization, and
artifact filenames stay with the application. A platform implementation must be
usable without importing FA code or knowing its schema.
