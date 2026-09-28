# Execution Context

`context` can join one request's approved execution metadata to the current
ApplicationGraph without including request bodies, results, exception text,
source expressions or repair replacement values:

```sh
supacloud-compiler context review \
  --events execution-events.json \
  --request-id request-123 \
  --json
```

The normal `context <name>` output is unchanged. Execution context is a separate,
read-only projection. It requires all three options and rejects `--write`.
The input file is explicitly selected; the compiler does not discover server
logs, read credentials, connect to a running service or export data externally.

## Observation Format

Use the application's `onExecution` observer or the equivalent compiled Job
observer to collect approved metadata into this envelope:

```json
{
  "version": 1,
  "events": [
    {
      "kind": "command",
      "operation": "review.approve",
      "stage": "authorize",
      "phase": "failed",
      "requestId": "request-123",
      "durationMs": 0.25
    }
  ]
}
```

Allowed event fields are exactly `kind`, `operation`, `stage`, `phase`,
`requestId` and `durationMs`. The last two are optional in the file, but only
events with the selected request ID can be correlated. Kinds are `route`,
`command` and `job`; phases are `started`, `succeeded` and `failed`.
IDs must be opaque correlation identifiers, never credentials, user names or
business data. The tool cannot determine whether a syntactically valid ID
contains a secret. Hosts own log access, retention and metadata naming policy.
Operation names are limited to 512 characters, stage names to 256, and request
IDs to 256 ASCII letters, digits, dots, underscores, colons or hyphens.

Unknown fields reject the entire input rather than silently accepting raw logs.
Unknown operations/stages, ambiguous owners and events outside the selected
graph neighborhood are counted but not echoed. Other request IDs are excluded.
Routes must use declared templates, not concrete URLs containing record IDs.
Legacy command class names are normalized to their declared operation names.

## Limits And Interpretation

- Input: a regular JSON file no larger than 1 MiB and no more than 2,048 events.
  The programmatic API also enforces the UTF-8 size of its canonical JSON input.
- Output: at most 32 KiB of formatted JSON including the CLI newline.
- Projection caps: 128 matched events, 16 modules, 64 files, 32 diagnostics and
  64 execution plans. Failed events take precedence; retained input order is
  preserved through the `index` field. Truncation counts are explicit.
- Oversized results fail with `EXECUTION_CONTEXT_TOO_LARGE`; select a smaller
  observation set. Invalid and unreadable inputs use fixed error codes without
  echoing their contents or paths.
- Absolute, parent-traversing and URL-shaped source paths are omitted; this
  lexical filter is not a filesystem/symlink attestation. Graph configuration values,
  diagnostic messages/suggestions and semantic fix payloads are not exported.

`correlation: "current-graph-only"` is deliberate. The current source graph may
differ from the code which emitted the events. `deploymentVerified: false` and
`eventsTrusted: false` prevent this structural match from being represented as
build provenance, authoritative audit, root-cause proof or successful recovery.
A failed outer stage may simply be propagating an inner failure.

Diagnostics are associated through the selected graph neighborhood, not inferred
to have caused a runtime failure. A repair readiness of `input-required` means
an operator must choose policy; the tool does not guess permissions or weaken
transaction/idempotency requirements. Use the existing `check --json` and
explicit `fix --dry-run` / reviewed `fix --write` workflow to inspect and apply
a semantic repair, then compile and test again.

## Verification

`bun run verify:starter` captures actual failed command and compiled attachment
Job events from the packed starter running against Lite. It invokes this CLI,
checks request isolation and diagnostic linkage, then separately previews,
applies and verifies an explicit semantic fix. This is local feedback evidence,
not full-platform identity or deployment acceptance.
The CLI regression also verifies that valid source with drifted or missing
generated output is inspected without repairing or recreating that output.

## Immutable Build Context

For observations collected from a specific delivered object, select its saved
manifest and target explicitly:

```sh
supacloud-compiler context review \
  --delivery-manifest /archive/delivery/delivery.manifest.json \
  --delivery-target api \
  --events execution-events.json \
  --request-id request-123 \
  --json
```

The observation envelope additionally requires:

```json
{
  "version": 1,
  "delivery": { "target": "api", "objectId": "<64 lowercase hex characters>" },
  "events": []
}
```

Use the actual selected object's ID, not a branch name or the topology digest.
The example's empty event array illustrates the format; successful correlation
requires a matching event for the requested ID. The launcher or collector must
record which object it executed. This caller-supplied identity is not signed
runtime provenance and can be forged along with the events.

Builds include `bundle/execution-context.json` in each object's hashed inventory.
It contains only target-projected execution plans, symbol aliases, relative file
references and diagnostic metadata, not source expressions, business payloads,
diagnostic messages or repair replacement values. The reader checks the declared
object ID and all inventoried file hashes and sizes; missing, changed, extra or
symlinked object entries fail closed. Older builds without this snapshot cannot
be correlated this way and never fall back to current source.
The target and entry kind must also match the hashed `bundle/target.json`;
renaming only the manifest mapping does not relabel an existing object.
Shared module/file/diagnostic dictionaries avoid repeating full dependency
neighborhoods. Snapshot schema and byte limits are checked before a build is
published, not deferred until its first inspection.

This mode runs before project configuration or source analysis. It can therefore
inspect an archived build with no source checkout, dependencies or project config
in the working directory. Keep the manifest beside `objects/<objectId>/...`;
archive the matching manifest when publishing a build, rather than assuming the
current manifest still selects an older object.

The result uses `correlation: "verified-build-snapshot"` and includes
`delivery: { target, objectId, artifactVerified: true }`. Both
`eventsTrusted` and `deploymentVerified` remain false. Verification establishes
local archive consistency, not the manifest publisher's identity, remote runtime
state, signed provenance or deployment success. Diagnostics come from the saved
build structure, never from unrelated current source.
Do not apply its repair readiness to an unrelated checkout. Select the matching
source version and run the current compiler checks and reviewed repair preview.

Manifest, snapshot and observation JSON are limited to 1 MiB each. Artifact
verification accepts at most 1,024 files, 64 MiB per file and 128 MiB total.
The existing event/count/output limits still apply, including the delivery
identity in the 32 KiB output budget. Failures use fixed error codes without
echoing paths, file contents or rejected metadata. Verification assumes no
concurrent writer to the selected immutable archive.

The detached HTTP regression builds an executable, removes its source project,
captures real failed-handler metadata and verifies both the loader and CLI against
the archived object. It checks mismatched target/identity, changed executable and
snapshot, extra files, missing files and symlinks. This is local feedback evidence;
the caller-provided identity and full-platform/runtime attestation remain separate.
