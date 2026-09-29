# Application Development Context

Status: **IMPLEMENTED (compiler projection and delivered-build reader)**. The contract and CLI are read-only.
The Web Console application view and a project-scoped Developer MCP are the next
consumers; they are **not** implemented here.

## Why

Encore's value is that one application model feeds local run, inspection, tracing
and delivery. SupaCloud already builds that model in `@supacloud/compiler`. This
document defines the stable, redacted projection that developer tooling should
share, so the Web Console and an AI/Developer MCP read the **same** structure and
evidence instead of inventing their own.

The projection is a view of `ApplicationGraph`, never a second source of truth.

## Command

```sh
supacloud-compiler dev-context ./src            # human-readable summary
supacloud-compiler dev-context ./src --json      # machine-readable contract
```

It analyzes the current source (read-only), then projects the graph. It does not
require up-to-date generated artifacts, write anything, connect to a database,
start the application or export request bodies. Use `check --json` when you need
the stricter artifact-drift and type-safety gate.

## Schema

`supacloud.application-development.v1`:

| Field | Contents |
| --- | --- |
| `schema` | `supacloud.application-development.v1` |
| `source` | Always `current-graph` |
| `deploymentVerified` | Always `false` |
| `modules` | name, className, file, tags, provider tokens, controller/command/job/query names, required resources |
| `routes` | module, method, full controller-prefixed path, controller, handler, canonical bound command, aspect names, `schemaKinds` |
| `commands` | module, name, permission, transaction, idempotency, audit, declared resource uses |
| `jobs` | module, name, mode, declared resource uses |
| `resources` | logical name + kind (from the [resource model](./application-resource-model.md)) |
| `resourceUses` | module/owner/resource/operations |
| `executionPlans` | the existing static stage plans |
| `diagnostics` | code, severity, file, line, repair readiness |
| `omitted` / `limits` | explicit truncation counts and the enforced caps |

Ordering is deterministic (modules, routes, commands, jobs, resources, use
entries and plans are sorted), so two runs over the same source produce the same
document.

## Redaction

The projection never includes:

- diagnostic messages, suggestions or repair replacement values;
- aspect/schema source expressions (aspect **names** and schema **kinds** only);
- credentials, authentication tokens, request bodies, results or business payloads;
- absolute, parent-traversing or URL-shaped source paths (omitted).

Diagnostic repair entries expose only `{ type, readiness }`, matching the
execution-context policy. Only positive integer diagnostic line numbers and
allowlisted schema-kind keys are retained. Declared names (including DI provider
tokens) and tags are structural metadata, not automatically secret-detectable;
hosts must not place credentials or business payloads in metadata names.

## Limits

`APPLICATION_DEVELOPMENT_LIMITS` bounds the document (64 modules, 128 providers,
256 routes, 128 commands, 128 jobs, 64 resources, 128 resource uses, 128 plans,
64 diagnostics, 64 KiB output). The provider budget is document-wide, including
providers lost with omitted modules in the count. Other collection caps apply to
their top-level arrays; module name inventories remain subject to the final byte
budget. Aspect and execution-stage order remains semantic, while inventories,
resource uses and diagnostics have canonical ordering. Text output reports
omissions and explicitly marks deployment as unverified.

Truncation is reported in `omitted`; a document
that still exceeds the byte budget fails with `APPLICATION_DEVELOPMENT_TOO_LARGE`
rather than silently producing a partial view.

## Interpretation

`source: "current-graph"` and `deploymentVerified: false` are deliberate. The
document describes the **current source declarations**, not a deployed build,
runtime state, successful activation, audit receipt or rollback. `schemaKinds`
says whether a route schema is declared, not that the runtime validated it.

## Delivered Build Snapshot

A delivery build embeds the same contract as
`objects/<objectId>/bundle/application-development.json`, projected to the build
**target** (only that target's modules, routes and jobs; resource uses of excluded
jobs are removed). Command/service factories remain conservative within included
modules, and explicitly module-required resources are retained. The
platform can serve a released application without a source checkout:

```ts
import { readApplicationDevelopmentContext } from "@supacloud/compiler";

const delivered = await readApplicationDevelopmentContext(
  "generated/delivery/delivery.manifest.json", "api",
);
// delivered.correlation === "verified-build-snapshot"
// delivered.delivery.artifactVerified === true
// delivered.context: ApplicationDevelopmentContext
```

Both the writer and reader use `APPLICATION_DEVELOPMENT_ARCHIVE_MAX_BYTES`
(**512 KiB**, formatted UTF-8 JSON including the final newline). The default
`createApplicationDevelopmentContext(graph)` and CLI budget stays **64 KiB**;
`{ byteBudget: "archive" }` selects the larger, still bounded budget. The wire
`limits.outputBytes` continues to describe the interactive budget. There is no
unbounded `enforceByteBudget: false` escape hatch. The writer validates its own
serialized contract before publication; an oversized rebuild fails without
replacing the previous build pointer.

The reader verifies the selected object's target identity and every inventoried
file hash before parsing, rejects malformed UTF-8, and validates every nested
record with a closed schema. This includes enums, execution-stage forms, source
paths, safe integer counters/lines, exact limit values, collection caps and the
aggregate provider cap. Structural labels are bounded to 512 characters without
control characters. Extra payload/credential/message/repair-value fields are
rejected, not returned. The exported parser returns a detached JSON value.

Retained modules, routes, jobs and route/job plans must belong to the selected
target; projection omissions do not permit cross-target entries. Hash validation
establishes archive consistency, not trust in its producer or authenticity of
declared names. A self-consistent rehashed archive still undergoes these checks. A missing, changed or unexpected artifact fails with
`DELIVERY_CONTEXT_INTEGRITY_FAILED`; it **never** falls back to the current
source checkout. `correlation: "verified-build-snapshot"` and
`deploymentVerified: false` still mean local archive consistency only: this is
not signed provenance, runtime state or deployment success.

## Consumers

- **Web Console (application developer view)**: render modules, routes, resources
  and diagnostics for a project, then connect a selected route to its static plan
  and its [execution timeline](./execution-context.md#business-execution-timeline).
- **Developer MCP**: expose the same document to an agent so it can read the
  application structure, edit code, compile, validate and read failure evidence
  without re-scanning the repository.

A Developer MCP must stay separate from the platform
[Operations MCP](./mcp-ai-operations.md): the operations MCP keeps its plan-only,
project-scoped, redacted policy. Developer tools may call endpoints or run tests
only against an explicitly selected local/test environment, never production.

## Next steps

1. Add project-scoped Developer MCP tools over the delivered-build read path.
2. Add the Web Console application developer view beside the existing runtime
   release view, sharing this one document.

## Verification

`packages/compiler/src/application-development.test.ts` covers the projection,
redaction, deterministic ordering, truncation and the byte budget.

`packages/compiler/src/application-development-delivery.test.ts` covers the
delivered-build artifact, self-consistent malformed archives, UTF-8 rejection,
target matching, large archive round trips and failed-rebuild pointer preservation.
`packages/compiler/src/application-development-validation.test.ts` covers nested
schema/redaction failures, provider limits and excluded-job resource isolation.
