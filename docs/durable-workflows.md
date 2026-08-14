# Durable Workflows

SupaCloud Durable Workflows is a project-scoped, PostgreSQL-backed execution ledger for code-defined, linear workflows. It uses the platform's existing PGMQ queue and is available through service-role-only RPCs and `@supacloud/js`.

## Why this is a SupaCloud service

Workflow durability belongs beside Queues and Scheduled Functions because it owns execution mechanics: leasing, retries, stale-attempt fencing, step checkpoints, cancellation, and an append-only event view. It does not belong in SupAuth, whose boundary remains identity, authentication, and authorization.

Applications still own business meaning. Approval decisions, document signing states, role assignments, and domain records stay in application tables protected by their own RBAC and RLS policies. A durable workflow may coordinate those operations, but it does not become their source of truth.

## Relationship to DBOS

[DBOS Transact TypeScript](https://github.com/dbos-inc/dbos-transact-ts) is a useful reference for durable execution semantics: deterministic workflow identity, PostgreSQL checkpoints, durable steps, retry, and recovery after process failure.

SupaCloud does not depend on `@dbos-inc/dbos-sdk`. The DBOS SDK currently requires Node.js 20 or newer and brings its own workflow registration, execution lifecycle, and PostgreSQL metadata model. SupaCloud already has a Bun runtime, tenant-local PostgreSQL, PGMQ, and Scheduled Functions. Reusing those primitives keeps one queue and one operational boundary per project.

Use DBOS directly in an application when it needs DBOS's decorator/programming model, durable sleep, notifications, fan-out, or richer programmatic workflow control. Use SupaCloud Durable Workflows when the requirement is a Supabase-compatible project service with explicit pull-based workers and no additional runtime.

## Execution model

Each project receives three private tables in `supacloud_workflows`:

- `runs` stores workflow identity, input, terminal output, and status.
- `steps` stores the current and completed linear steps, attempt counters, leases, and results.
- `events` provides ordered, cursor-based lifecycle history.

Pending work is stored in the reserved `supacloud_internal_workflows` PGMQ queue. Names beginning with `supacloud_internal_` cannot be used through `pgmq_public` or SupaCloud's queue-management API.

The initial contract is intentionally narrow:

- one active step per run;
- unique step keys within a run;
- explicit worker polling and visibility timeouts;
- 1 to 100 attempts per step;
- idempotent start, advance, completion, retry, failure, and cancellation replay;
- stale attempt rejection after another worker reclaims a step;
- ordered event pagination.

PGMQ message IDs, queue message IDs, event cursors, and run row versions are returned as decimal strings so JavaScript clients never lose PostgreSQL `bigint` precision.

It does not provide BPMN, a visual designer, arbitrary DAGs, cross-project workflows, signals, child workflows, or a workflow-definition registry.

## Server-side SDK

Create the Supabase client with the project's service-role key. Never ship that key to a browser or mobile client.

```ts
import { createClient } from "@supabase/supabase-js";
import { createSupaCloudClient } from "@supacloud/js";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const supacloud = createSupaCloudClient({
  supabase,
  managementApiUrl: process.env.SUPACLOUD_MANAGEMENT_URL!,
  projectRef: process.env.SUPACLOUD_PROJECT_REF!,
});

await supacloud.workflows.start({
  runId: crypto.randomUUID(),
  workflowName: "invoice.issue",
  workflowVersion: "1",
  firstStepKey: "validate",
  input: { invoiceId: "inv-123" },
  maxAttempts: 3,
});
```

A worker repeatedly claims a step and records exactly one outcome:

```ts
const claim = await supacloud.workflows.claim({
  workerId: "invoice-worker-1",
  visibilityTimeoutSeconds: 300,
});

if (claim?.status === "claimed") {
  await supacloud.workflows.advance({
    stepId: claim.stepId,
    messageId: claim.messageId,
    attempt: claim.attempt,
    workerId: claim.workerId,
    output: { valid: true },
    nextStepKey: "render",
    nextInput: claim.input,
  });
}
```

Use `retry` for a transient error, `fail` for a terminal error, `complete` for the last step, and `cancel` for an active run. Mutating calls may be retried after a lost response with the same request. Changing the payload of an already-applied request produces an idempotency conflict.

`claim` can return `null`, `claimed`, `dead_lettered`, or `discarded`. A discarded result means the internal queue contained an invalid, orphaned, or no-longer-claimable message; it has already been archived and the worker can continue polling. A `40001` claim error indicates concurrent work on the same run; retry the claim because its queue lease was rolled back.

## Security and operations

- Only `service_role` can execute the public workflow RPCs.
- Workflow tables, sequences, and internal functions are not granted to Data API roles.
- `anon` and `authenticated` cannot inspect or mutate the internal queue.
- A worker completion is accepted only for the exact message ID, attempt number, and worker ID that claimed the step.
- Inputs, outputs, and errors are durable project data. Do not place secrets or customer-sensitive plaintext in them unless the project data policy explicitly permits it.

Fresh tenants install the schema during bootstrap. Existing tenants receive the same idempotent module through the tenant schema migration path. SupaCloud Lite installs the identical SQL contract on its PGlite-backed PGMQ emulation.

To roll back application adoption, stop workers and stop starting new runs first. The safest platform rollback leaves the private ledger intact while removing callers; deleting workflow tables would discard recovery and audit evidence.
