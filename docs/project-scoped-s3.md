# Project-scoped S3 storage

## Task contract

Goal: different SupaCloud projects can use different S3-compatible endpoints,
credentials and physical buckets. All logical Storage buckets in one project use
that project's single backend. Existing Storage API paths, project identity and
RLS remain authoritative. Clients never choose an upstream URL or credential.

Non-goals: bucket-level backend selection, failover, replication, migration,
import of existing upstream objects, cross-project copy, console UI, or changing
SupaCloud Lite's independent runtime. This implementation adds management APIs;
it does not add a new project-creation UI or change legacy provisioning scripts.

Required review areas: Bun/TypeScript, Elysia local-hook scope, project identity,
control-secret encryption, PostgreSQL transaction boundaries and error redaction.

## Configuration

The platform operator must explicitly allow each S3 origin in the Management API
process environment. This new setting is not a list of failover destinations:

```sh
SUPACLOUD_PROJECT_S3_ALLOWED_ORIGINS=https://s3.us-east-2.amazonaws.com,https://account-id.r2.cloudflarestorage.com
```

Origins must match normalized configuration origins exactly (no wildcard and no
trailing slash). HTTPS is recommended. HTTP or a private-network MinIO endpoint
requires an explicitly approved origin. This is operator-controlled network
configuration, not permission for an ordinary tenant to probe arbitrary URLs.
Exact-origin checks do not establish DNS/IP safety; deploy appropriate egress
rules, trusted DNS and least-privilege S3 credentials. The read-only probe rejects
redirects and has a three-second timeout. No TLS verification is disabled.

Create a project using the existing project workflow, then bind its existing,
dedicated upstream physical bucket before creating any logical Storage buckets.
Only a platform admin/master may manage this setting in this first version.
The physical bucket is attached, not created or destroyed by this API.

### Bind or rotate

`PUT /v1/projects/:ref/storage/config` with the existing admin authorization:

```json
{
  "expected_revision": null,
  "settings": {
    "endpoint": "https://s3.us-east-2.amazonaws.com",
    "region": "us-east-2",
    "bucket": "customer-a-assets",
    "prefix": "supacloud/project-a/",
    "virtualHostedStyle": false,
    "accessKeyId": "<project-scoped access key>",
    "secretAccessKey": "<project-scoped secret>",
    "enabled": true
  }
}
```

`sessionToken` is optional for temporary credentials. Secrets must be submitted
through HTTPS or a trusted local operator connection, never in a URL or command
line argument. Missing, empty or masked credentials are rejected. Request JSON is
bounded to 32 KiB and parsed after authorization so validation errors cannot echo
submitted credentials. Unknown fields are not persisted.

The result contains the namespace, an opaque `revision`, and credential status;
access key, secret key and session token are never returned. Read the same safe
summary with `GET /v1/projects/:ref/storage/config`. A legacy project has
`{"backend":"platform","configured":false}`.

To rotate credentials or disable/re-enable a project, submit all settings again
with the current `expected_revision`. Endpoint, region, physical bucket, prefix
and addressing mode must remain unchanged. Wrong revisions or namespace changes
return `STORAGE_CONFIG_CONFLICT`. There is deliberately no delete-binding API:
a disabled/misconfigured binding must never become an implicit platform fallback.
Rotating credentials takes effect for subsequent operations; an in-flight
operation keeps its immutable client snapshot. Internal image links live at most
60 seconds and must be treated as sensitive by the image processor's logging.

A first binding is rejected when the project already has logical buckets,
objects, multipart metadata, TUS sessions or signed-upload sessions. This is not
a migration tool. Previously orphaned upstream objects are not imported or moved.
Same-endpoint/same-bucket overlapping prefixes across configured projects are
rejected, including disabled projects. Alternate DNS aliases for the same
physical service cannot be recognized automatically: prefer a dedicated bucket
and restrict credentials to the project namespace at the provider.

### Probe

`POST /v1/projects/:ref/storage/config/probe` probes only the saved, approved
namespace with a signed ListObjectsV2 request. It accepts no destination URL. A
successful response reports `reachable` and `listable`; `writable` remains
`"not_tested"`. It does not write or delete a probe object and does not promise
provider feature parity from a successful list request.

## Storage and routing

Configuration is persisted as one encrypted, project-bound JSON record in the
existing `project_control_secrets` table: scope `connector`, reserved name
`supacloud.storage.s3`. It therefore participates in existing control-secret
backup/encryption-key rotation. The general control-secret API cannot write,
remove or reveal this record. No credential is placed in public project JSON,
the edge-function environment, `storage.buckets`, or `storage.objects`.

The logical path remains `bucket/object-name`. The S3 key is
`project-prefix + logical-bucket + '/' + object-name`, and the physical bucket is
fixed by the project configuration. Each operation receives an immutable
project/client pair. There is no endpoint-only cache or mutable current project.
New configurations are used even when the instance's legacy driver is local or
JuiceFS. Copy/move stays within the current project; it is not cross-source copy.

The existing legacy driver classes remain in `storage.adapter.ts`; the exported
factory now routes by project. Only an absent configuration preserves the old driver,
physical bucket and key layout. Database lookup/decryption failures, disabled
configurations, revoked origin permissions and S3 failures never try another
backend. Backend errors are sanitized rather than reported as an empty bucket.

The registry serializes initial binding with legacy object IO using PostgreSQL
advisory locks. Configured operations do not hold a database transaction across
S3 IO. All namespace-changing registration is serialized, and updates use an
expected revision. Native PostgreSQL concurrency acceptance is covered by
`tests/integration/project-storage-concurrency.test.ts`, which runs against a
real PostgreSQL in CI and proves that a first binding waits for in-flight legacy
IO on a separate connection, that a corrupt binding fails closed without falling
back, and that two concurrent bindings have a single winner. The in-memory SQL
unit fixture remains the fast check, not the concurrency evidence.

A binding whose stored record cannot be decrypted or parsed belongs to a project
that cannot serve storage, so it is skipped when evaluating overlap for a new
binding. One corrupt project row therefore cannot block every unrelated first
binding; a later repair of that project re-runs the same overlap check.

Existing public/signed Storage API URLs remain unchanged. The management image
routes request an internal, short-lived presigned URL for the same project
namespace. Upstream image errors do not expose that URL to callers or logs.
Project capability/environment responses report the resolved backend rather than
only the instance default. The instance-level storage status remains an instance
probe; use the project config probe for a project's external S3.

Lists and prefix cleanup cover pagination with bounded concurrency and guard
against out-of-scope keys and non-progressing pages. A logical bucket deletion
never deletes the customer's physical bucket. File bodies are still buffered as
in the existing adapter; this PR does not claim new large-file streaming or
atomic conditional-write support. The new S3 driver does not advertise a
conditional-write capability it has not implemented.

## Acceptance and verification

```sh
cd packages/management-api
bun test tests/unit/project-storage.test.ts
bun test tests/unit/project-storage-http.test.ts
bun test tests/unit/project-storage-boundaries.test.ts
PROJECT_STORAGE_CONCURRENCY_TEST_DATABASE_URL=postgres://... bun test tests/integration/project-storage-concurrency.test.ts
bun run typecheck
bun run test:unit
```

The pure core tests can also run after TypeScript transpilation under Node's test
runner. They cover concurrent identical keys in two projects, metadata redaction,
credential rotation, CAS, immutable destinations, disabled/corrupt configurations,
no fallback on failure, pagination and prefix-limited cleanup. These use injected
S3 and SQL fixtures, not a live provider or database.

Bun-specific tests exercise Elysia authorization/body-error redaction, reserved
control-secret protection, image routing/redaction, and two distinct local HTTP
S3 fixtures accessed by real Bun S3Client instances. The HTTP fixture checks the
project's access-key identity in signed requests; it is not a SigV4 verifier or a
full AWS/MinIO/R2 conformance suite.

Before production acceptance run provider upload/download/list/delete, credential
rotation, project ACL denial and native PostgreSQL concurrent registration tests.
Do not count skipped provider/database tests as successful validation.

## Rollout, risk and rollback

Roll out code before registering projects. There is no data migration and no new
schema or package dependency. Keep dedicated customer namespaces and provider IAM
policies; review capacity limits before large-file workloads. Explicit origin
approvals must be propagated consistently to all Management API instances.

Removing an approved origin or setting `enabled:false` fails new operations for
that project; it does not fail over. Do not deploy pre-feature code while external
bindings are active: it would ignore the binding and use legacy storage. Rollback
requires quiescing affected project traffic first and retaining the encrypted
configuration and upstream objects; resume only with a version that understands
the bindings. Do not delete a binding to "repair" a failed connection.
# PM review acceptance

The operator's job is to bind an unused project to its own storage and retain
predictable access, isolation, and failure behavior. This change does not add a
console workflow, migration, failover, or bucket-level backend selection.

```gherkin
Scenario: Isolated projects
  Given two projects bound to separate S3 namespaces
  When they upload the same logical bucket and object name concurrently
  Then each project reads only its own content

Scenario: Preserve object metadata
  Given an object uploaded with an explicit content type
  When the object is downloaded or copied to another logical bucket
  Then its content type and bytes are preserved

Scenario: Fail closed
  Given a disabled, corrupt, or unapproved project binding
  When storage is accessed
  Then access fails without using platform storage

Scenario: Safe configuration lifecycle
  Given an occupied project or a stale configuration revision
  When an administrator attempts to bind or update storage
  Then the operation conflicts without changing the binding

Scenario: Credential privacy
  Given a configuration request containing credentials
  When authorization or parsing fails
  Then the response does not expose credentials
```

Review verification (2026-09-28): the real Bun S3 HTTP fixture reproduced lost
download MIME metadata before the fix. Downloads now read stored metadata with
`stat()`, and the fixture checks that copying preserves it as well.
Native PostgreSQL concurrency and cloud-provider acceptance remain release gates;
in-memory registry tests do not prove those properties.
