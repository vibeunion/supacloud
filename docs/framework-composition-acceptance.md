# Framework Composition And Recovery

## Task Contract

- Source: user request, 2026-09-24, to complete the Medusa, Restate and tRPC
  reference directions without reducing existing capabilities.
- Parent: the existing Vibecoding development workflow and command binding.
- Goal: demonstrate reusable cross-module business composition across HTTP,
  event, scheduled and CLI hosts; make existing retry/recovery decisions
  observable; improve generated clients without handwritten response types.
- Non-goals: a new workflow engine, a Restate/Medusa/tRPC runtime dependency,
  distributed transactions, implicit compensation, changed authentication,
  production writes, package publication, or removing existing transports.
- Ownership: one local writer. Native orchestration, medium risk, one independent
  read-only verifier after deterministic tests. No other writer is delegated.
- Stack: existing Bun/TypeScript, compiled Elysia command bindings, existing
  command store and Workflow ports. No database schema or deployment changes.
- Scope: `packages/commands`, the Elysia composition example/tests,
  generated client implementation/tests in `packages/compiler`, related docs.
- Recovery: `agmesh` is unavailable on PATH. Existing coordination DB was inspected
  read-only; no active task with this specific writer scope was identified.
  No automated deployment or coordination-schema mutation is authorized.
  Optional tooling can be restored with `npm install -g agmesh && agmesh install`;
  this task did not run installation or deployment.
- Rollback: remove the additive example/observer options and revert client error
  generation. Do not revert unrelated working-tree changes.

## Acceptance

1. One domain composition invokes separately governed module steps from HTTP,
   worker events, scheduled work and a trusted CLI call. Each entry retains
   current identity and authorization. Repeated invocation uses host-owned
   command receipts, not a second workflow journal.
2. Compensation is a separately authorized business command, only following
   confirmed domain rejection. Unknown results, thrown errors and audit-pending
   receipts stop progression; they never authorize compensation or a resend.
3. Retry policy still distinguishes reads, confirmed rollback and unknown writes.
   Optional observation records attempts/decisions, not inputs, results, raw
   exceptions or credentials. Observation failure cannot change execution.
4. Recovery records lookup and settlement separately. A lost acknowledgement
   remains a failure, and redelivery only performs receipt recovery.
5. Generated clients infer input/output from existing route schemas. Contract
   changes reject stale callers. Undeclared HTTP and invalid response failures
   have structured metadata without embedding raw server bodies in messages.
6. Declared non-2xx response unions, decoder overloads, binary/stream handling,
   REST, GraphQL, existing command entrypoints and ordinary CRUD stay available.
7. Focused tests, affected package typechecks/builds, compatibility checks and an
   independent review must pass before local completion. Local evidence does
   not establish real-database crash recovery or production acceptance.

## Reference Boundaries

Primary upstream sources were read as design references, not installed:

- Medusa `packages/core/workflows-sdk/src/utils/composer/create-step.ts`:
  explicit invocation and compensation functions. SupaCloud keeps plain
  TypeScript composition and existing command governance.
- Restate TypeScript SDK README: durable execution belongs to
  an execution runtime. SupaCloud keeps its existing receipt/Workflow/pgflow
  ownership, not an in-memory imitation of durable execution.
- tRPC `packages/server/src/unstable-core-do-not-import/error/TRPCError.ts`:
  machine-readable error identity. SupaCloud retains generated HTTP clients
  and does not require tRPC transport or server implementation imports.

See [the developer guide](framework-composition.md) for the supported pattern,
failure table and executable example.

## Local Evidence, 2026-09-24

Status: **PASS for the local framework scope**, not published or deployed.
The tests below were run with Bun **1.4.2**, obtained in the npm execution cache
without replacing the machine's Bun 1.4.0 installation or changing lockfiles.

| Requirement | Current evidence |
| --- | --- |
| Shared multi-entry composition | `packages/elysia/src/fulfillment.test.ts`: real HTTP and Worker adapters plus a trusted direct call share separately bound inventory/payment/order steps; effects are deduplicated by the test store and every invocation reauthorizes |
| Explicit steps, extension points and compensation | Existing `command-binding.test.ts` and new fulfillment tests cover module/command aspects, denied compensation, unknown payment, audit-pending results, unknown reserve/confirm/release receipts and thrown errors |
| Retry/observation | Complete `packages/commands` suite: **34 passed**, including read retry, driver-confirmed rollback, unknown write refusal, cancellation, circuit rejection, metadata redaction and observer failure isolation |
| Recovery/settlement | Recovery and observation tests cover pending/invalid/expired receipts, denied recovery, lost complete/retry/fail acknowledgements, and receipt-only redelivery |
| Client contract and compatibility | Complete `packages/compiler` suite: **416 passed**, including stale consumer rejection after Schema changes, browser bundling, response unions, raw/binary/stream routes and GraphQL |
| Runtime compatibility | Elysia focused suites (`fulfillment`, `command-binding`, `direct-command`, `execution`, `persistent-command`, `conformance`): **46 passed** against the recorded compatibility tuple |
| Build and declarations | `bun run build` passed in commands, compiler and Elysia; all three test tsconfigs passed; compiler must finish its declaration build before building Elysia |
| Built compiler consumer | `bun run test:package`: **6 passed**, using `dist/cli.js`, not just source imports |
| Existing public surface | `bun scripts/check_public_api.ts`: app **301** and compiler **162** exports match existing snapshots; no snapshot weakening or removal |
| Architecture and diff | `bun run check:boundaries` and scoped `git diff --check` passed |
| Independent review | One read-only verifier found and then confirmed fixes for generated error/Schema name collisions and response-body transport error misclassification; added regressions pass |

The broad test commands can be reproduced by prefixing `bun` with:

```sh
npm exec --yes --registry=https://registry.npmjs.org --package=bun@1.4.2 -- bun
```

Initial default-timeout client type tests and a temporary-directory browser
dependency resolution failed; the final tests use a bounded 60-second timeout
and resolve the actual installed TypeBox package. The initial Elysia conformance
run correctly rejected Bun 1.4.0; the compatibility matrix was not weakened.
A parallel compiler/Elysia build encountered a temporarily missing compiler
declaration; rebuilding Elysia after its dependency completed passed.

Review fixes reserve generated error identifiers when importing public schemas.
JSON body transport reads are outside the parse-error catch, so even a stream
`SyntaxError` remains the original transport failure. HTTP errors keep the
unconsumed response available for explicit inspection, without serializing it.

No Medusa, Restate or tRPC runtime dependency, database migration, new scheduler,
identity bypass, automatic external resend, release or production write was
introduced. Composition tests intentionally use a deterministic store double;
real PostgreSQL concurrency, process-kill recovery and external-provider effect
guarantees remain the existing application/deployment acceptance responsibility.

Clean-code guard: the new error constructor uses a details object, receipt
completion is named as a predicate, shared observation is reused by two paths,
and no generic workflow engine or extra dependency was added.
