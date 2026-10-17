# Attachment Result Recovery

The approval attachment Job now reconciles a durable result before downloading
or hashing the artifact again. This handles a process exit after the result
transaction commits but before Workflow acknowledgement is confirmed.

## Acceptance

- Given a committed result and an unacknowledged Workflow attempt, when the queue
  redelivers the job, then the current worker reauthorizes and returns the stored
  result without reading Storage or inserting another result.
- Given revoked membership, changed review ownership/revision, or a different
  project/tenant binding, when a stored result is requested, then replay fails.
- Given malformed or mismatched persisted JSON, when recovery reads it, then the
  shared Job output contract rejects it; it is not treated as a cache miss.
- Given no committed result, when the job runs, then it downloads, verifies and
  commits normally; concurrent executions converge on the same durable result.
- Given a lost completion response, when the canonical Workflow receipt is read
  or settled again with the same attempt/output, then the existing Workflow state
  is authoritative; the recovery helper does not start a new run.

## Adoption

Adopt the generated `src/review/attachment.ts` and
`src/host/review-attachments.ts` together. `ReviewAttachmentStore.readResult` is
required for custom stores: reauthorize under current business rules, validate
the shared output schema and input binding, and return `null` only when the
record is absent. Do not convert connection failures or corruption into `null`.

No database migration or new runtime grant is needed: the existing worker role
already has SELECT on `starter_attachment_results`. Historical migrations stay
unchanged. `AttachmentResult` remains the source for durable-result validation,
including bounds, UUID/hash formats, and extra-property rejection.

## Recovery Boundaries

The stored result is a verification receipt for the immutable registered
artifact, not a new check of the current bytes in Storage. Operators must retain
the existing immutability and privileged-access controls. Redelivery without a
committed result can still repeat the read/hash work; this is not exactly-once
execution.

The Workflow service still owns leases, attempt fencing, retry budgets and
terminal status. A failed or cancelled run is not automatically reopened. The
worker still halts on uncertain settlement/ownership; inspect canonical status
and the cause before restarting. This change does not provide a browser-visible
status endpoint, an operator recovery UI, or transactional external side effects.

## Local Verification

Build the local `@supacloud/elysia` and `@supacloud/js` packages with their
dependencies installed, then run only the focused file from `packages/elysia`:

```sh
SUPACLOUD_STARTER_POSTGRES_BIN=/opt/homebrew/bin \
SUPACLOUD_REQUIRE_RUNTIME_SAFETY=1 \
bun --no-env-file test src/starter-attachment-recovery.test.ts --timeout 30000
```

Use the PostgreSQL binary directory appropriate to the machine. The harness
creates its own loopback database, applies the actual starter/runtime SQL and
uses the non-BYPASSRLS worker role. It exercises the emitted Job and adapter,
strictly typechecks their generated source, and uses the canonical Workflow
claim/completion functions with Lite SQL queue compatibility. Artifact/Storage
HTTP responses are fixtures. This is not native pgmq, real Storage, JWT gateway,
production deployment or xigu-fa acceptance.
