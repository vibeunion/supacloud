# Optional AI Operations MCP

[English](mcp-ai-operations.md) | [简体中文](mcp-ai-operations.zh-CN.md)

SupaCloud provides an optional, customer-facing AI operations surface over the
Streamable HTTP MCP protocol. It is disabled as a product capability
unless the customer explicitly connects an MCP client and presents an
existing SupaCloud admin or project-scoped credential.

## Contract

- Endpoint: `POST /mcp` for platform administrators.
- Endpoint: `POST /mcp/projects/{project_ref}` for a project-scoped client.
- Endpoint: `POST /mcp/developer/projects/{project_ref}` for the read-only
  Developer MCP surface (application development context only).
- Protocol: `2025-06-18`.
- Transport: JSON-RPC over `application/json`.
- State model: stateless. SupaCloud does not return `Mcp-Session-Id`, keep a
  session map, or store model conversation state.
- Authentication: existing `Authorization: Bearer ...` admin/project auth.
- Response caching: disabled with `Cache-Control: no-store`.
- Write policy: plan-only. A model cannot execute shell commands, receive
  database credentials, or directly perform a restore through MCP.

## Developer MCP surface

The Developer MCP is a separate, project-scoped, read-only surface. It exposes
only `supacloud.get_capabilities` and
`supacloud.get_application_development`, reports
`write_policy: "read_only"`, and never lists backup or metrics resources. It
does not replace the plan-only operations surface, and the operations endpoint
does not expose the development tool. Both surfaces read the same
`supacloud.application-development.v1` contract that the application developer
console consumes, so AI and the console cannot drift.

`supacloud.get_application_development` reads one immutable application
release target and returns the validated development contract (modules,
routes, resources, resource uses, execution plans, and diagnostics) with
`correlation: "verified-build-snapshot"`. The bytes come from the release
archive that `ApplicationReleaseStorage` already hash-verified, so the result
is build evidence, not a re-inference from current source.

The client should send the `MCP-Protocol-Version` request header after
initialization. The server returns the same protocol version in responses. A
`notifications/initialized` request receives `202` with an empty body.

## Tools

### `supacloud.get_capabilities`

Returns the machine-readable AI operations contract, including scope, tools,
resources, stateless behavior, and write policy.

### `supacloud.get_backup_readiness`

Returns project backup evidence from the configured Pigsty/pgBackRest
inventory:

- stanza and PITR configuration state;
- count of completed, readable backups;
- latest completed backup;
- readiness status.

The tool reads the authoritative pgBackRest inventory. It does not infer
success from a shell exit code alone.

### `supacloud.get_request_metrics`

Returns the current Management API Prometheus metrics, including request,
error, and status counters. These metrics are process-local and should be
combined with the customer's external metrics retention for incident history.

### `supacloud.plan_pitr_restore`

Creates a non-executing PITR restore plan for an RFC3339 UTC timestamp. The
plan records the project, target, prerequisites, approval requirement, and
confirmation string. Execution remains behind the normal backup API workflow,
maker-checker approval, idempotency, audit, operation receipt, and post-restore
health verification.

### `supacloud.get_application_development` (Developer MCP only)

Available only on `POST /mcp/developer/projects/{project_ref}`. Reads the
validated `supacloud.application-development.v1` contract for one immutable
application release target. Inputs: `application_id`, `release_id`, and
`target`. The result is read-only build evidence and never executes
application code.

## Resources

- `supacloud://capabilities`
- `supacloud://project/{project_ref}/backups`
- `supacloud://project/{project_ref}/metrics`

Project-scoped credentials can read only resources for their own project.
Platform administrators can use the platform endpoint and explicitly provide a
project reference where the tool schema allows it.

## Example

```http
POST /mcp/projects/demo-project
Authorization: Bearer <existing-project-or-admin-token>
Content-Type: application/json
MCP-Protocol-Version: 2025-06-18
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "supacloud.plan_pitr_restore",
    "arguments": {
      "target": "2026-09-07T00:00:00Z"
    }
  }
}
```

## Customer integration requirements

An AI client integration should:

1. Keep the MCP connection opt-in and tenant-scoped.
2. Treat tool results as evidence, not authorization to mutate state.
3. Display the returned plan and require a human approval step before any
   existing write API is called.
4. Persist the operation receipt, trace ID, correlation ID, and audit event
   across the approval and execution workflow.
5. Redact bearer tokens, database URLs, passwords, service-role keys, and
   provider credentials from prompts, logs, tool output, and exported traces.
6. Retry only idempotent reads. Long-running writes must use the existing
   operation status and receipt APIs rather than MCP session state.

Pigsty/pgBackRest backup configuration remains an infrastructure concern. MCP
exposes its verified inventory and planning inputs; it does not replace
Pigsty, pgBackRest, backup retention, off-site repository replication, or
restore drills.
