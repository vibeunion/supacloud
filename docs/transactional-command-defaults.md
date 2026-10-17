# Transactional command defaults

This increment removes durable execution wiring from the approval starter. It
does not replace PostgREST reads, the Workflow engine, or application ownership
of permissions and state transitions. It does not migrate an existing customer
application automatically.

## Acceptance

```gherkin
Feature: Approval without application-owned execution infrastructure
  Scenario: Duplicate approval
    Given one authorized actor and one pending review
    When concurrent requests use the same key and input
    Then one business write and one audit commit
    And later retries return the stored result

  Scenario: Atomic rejection of an invalid outcome
    Given an approval changes a database row
    When its result violates the response contract or audit persistence fails
    Then the row change and execution receipt roll back

  Scenario: Revoked authorization
    Given a successful approval receipt
    When the actor loses access and reuses its key
    Then authorization denies the request before replay

  Scenario: Isolated transaction scopes
    Given concurrent approvals
    When each handler accesses its repository
    Then it uses only its own transaction
    And transaction access fails after the handler completes

  Scenario: One contract per fact
    Given shared approval parameter, body and response schemas
    When HTTP validation and durable execution accept a request
    Then both use the same schemas
    And no hand-maintained duplicate input or result validator is needed

  Scenario: Inspect an uncertain operation without submitting it
    Given the original operation key and input
    When the host calls binding.lookup with verified request context
    Then the current business authorization is checked
    And a committed receipt is returned without invoking the business handler
    And an absent receipt returns null without creating a write, receipt or audit

  Scenario: Recovery fails closed
    Given a pending client operation
    When access was revoked, its input changed or the database is unavailable
    Then lookup reports denial, conflict or an unavailable/unknown outcome respectively
    And no failure is translated into an absent receipt or another execution
```

## Ownership

`createTransactionalCommandGovernance` binds one local compiled Command to an
existing `createTransactionalCommand` executor and a supplied command store.
With `createPostgresCommandStore`, business writes, durable receipts and audit
use the same PostgreSQL transaction. Installation remains a migration operation,
never a request-time operation.

The host verifies identity and project/tenant database ownership. The
definition's authorization callback checks current business access inside the
transaction, including on replay. The application supplies business SQL and
state transitions. Use `binding.transaction()` only during the awaited command
continuation; repositories must not cache transactions or start detached work.

## Read-only recovery

The returned binding also exposes `lookup(invocation)`. Supply the same compiled
Command metadata, original idempotency-key header and original input mapping,
with freshly verified request context. It reuses the existing durable executor's
lookup, schema decoding and transactional authorization. It never calls the
business continuation, inserts a receipt, writes audit or invokes the rejection
mapper. No separate receipt store or second Command definition is needed.

```ts
const receipt = await binding.lookup(invocation);
if (receipt === null) {
  // Keep the client's pending marker; absence is not proof of rollback.
  return { status: "unresolved" as const };
}
return { status: "confirmed" as const, result: receipt.result };
```

This is a host API, not an automatically installed HTTP endpoint. The host owns
the authenticated lookup route and its response contract. Map the validated
result into that contract; do not forward internal receipt identifiers or input
payloads by default. Client `createPendingCommandRecovery` transports can use
that route and match the authority against the original request.

Lookup checks the same metadata binding as execution and maps protocol failures
to the same HTTP status/retry metadata. A changed body with the same key conflicts;
revoked access is denied even when a receipt exists. Database/receipt errors are
not converted to null. A connection failure before the transaction starts reports
`COMMAND_UNAVAILABLE`; an unconfirmed transaction reports `COMMAND_OUTCOME_UNKNOWN`.
Neither response proves the outcome of the original write.
Do not use null to clear a pending client marker, generate
a replacement key or automatically call execute: it is only an observation at
the lookup's transaction boundary, not proof that an in-flight request cannot
still commit.

"Read-only" means no command execution or receipt/audit mutation, not a
PostgreSQL READ ONLY transaction: authorization and serialization can acquire
locks. Keep authorization callbacks lookup-safe; do not perform business writes
or external effects in them. Lookup does not expose `binding.transaction()` to
route handlers. No new schema, privilege or migration is required.

The binding rejects mismatched command metadata and RPC/external commands.
Protocol failures use the existing public status and retry metadata. An explicit
rejection mapper may translate known business errors; unknown exceptions,
invalid results and uncertain commits are not advertised as safe to retry.

The outer authorization callback verifies the binding and host identity;
business access is checked by `definition.authorize` during durable execution.
A preview must provide its own read-only business actionability checks; identity
validation alone is not an approval decision.

Input retention requires an explicit codec. The starter opts into plaintext for
its non-secret review ID and expected version. Sensitive inputs require a
suitable codec and retention policy.

## Contracts

The approval starter derives its durable input from the existing path/body
schemas and its result decoder from the HTTP response schema, with normalization
disabled. Database row types remain database-owned; business result types use the
response contract. Different models are permitted, but their mapping is explicit.
Generated clients and OpenAPI continue through the existing compiler pipeline.

## Adoption

Publish the updated adapter before publishing a CLI starter that imports its
new export. Repository builds are not proof that those releases are available.
For an existing application, replace its local transaction-scope/governance
wiring with the binding, retaining its authorization SQL, input codec, schema
definitions and rejection policy. There is no new database schema or migration.
The binding owns one Command; do not apply it as an unrestricted multi-command
registry or as a second wrapper around an already-persistent RPC.

The starter keeps the path ID authoritative over any body property. Its durable
input is composed from path/body schema properties, and integer bounds are shared
with the HTTP contract. Unsupported metadata now reports
`COMMAND_BINDING_MISMATCH`; known approval conflicts retain their existing
`COMMAND_IDEMPOTENCY_CONFLICT` mapping.

## Verification

Run only the affected test file, using a local PostgreSQL binary directory:

```sh
cd packages/elysia
SUPACLOUD_STARTER_POSTGRES_BIN=/path/to/postgresql/bin \
SUPACLOUD_REQUIRE_RUNTIME_SAFETY=1 \
bun --no-env-file test src/transactional-command.test.ts --timeout 30000
```

The test creates and removes its own loopback cluster; it does not accept a
server URL. The queue dependency uses Lite's SQL compatibility implementation,
not the native pgmq extension. Tests exercise real PostgreSQL transactions and a
generated approval host using local signing keys, not a deployed SupAuth server.
The generated host and its imported business sources are typechecked with the
starter's strict indexed-access and optional-property settings.

## External effects and adoption boundary

Never send mail, upload files or call a remote API inside the transaction and
claim atomicity. Enqueue work through the existing transactional Workflow/outbox
integration and use its existing reconciliation rules. The starter's
`afterApproved` hook remains database-only.

This is an approval-write increment. Query defaults, background-task ergonomics
and xigu-fa adoption require their own scoped acceptance. Local PostgreSQL
verification does not establish package publication, deployment, production
identity acceptance or a completed customer migration.
