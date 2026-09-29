# Application Development Context

Status: **IMPLEMENTED (compiler projection)**. The contract and CLI are read-only.
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
| `routes` | module, method, path, controller, handler, bound command, aspect names, `schemaKinds` |
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
- credentials, tokens, request bodies, results or business payloads;
- absolute, parent-traversing or URL-shaped source paths (omitted).

Diagnostic repair entries expose only `{ type, readiness }`, matching the
execution-context policy.

## Limits

`APPLICATION_DEVELOPMENT_LIMITS` bounds the document (64 modules, 128 providers,
256 routes, 128 commands, 128 jobs, 64 resources, 128 resource uses, 128 plans,
64 diagnostics, 64 KiB output). Truncation is reported in `omitted`; a document
that still exceeds the byte budget fails with `APPLICATION_DEVELOPMENT_TOO_LARGE`
rather than silently producing a partial view.

## Interpretation

`source: "current-graph"` and `deploymentVerified: false` are deliberate. The
document describes the **current source declarations**, not a deployed build,
runtime state, successful activation, audit receipt or rollback. `schemaKinds`
says whether a route schema is declared, not that the runtime validated it.

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

1. Serve this contract from a delivered build snapshot so the console and MCP can
   read a released application without a source checkout.
2. Add the project-scoped Developer MCP tools over that read path.
3. Add the Web Console application developer view beside the existing runtime
   release view, sharing this one document.

## Verification

`packages/compiler/src/application-development.test.ts` covers the projection,
redaction, deterministic ordering, truncation and the byte budget.