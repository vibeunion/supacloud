# Environment Bindings

Status: **IMPLEMENTED (static resolution slice)**. The compiler resolves each
explicit `@InfraResource` to an opaque reference for one selected environment.
Missing, unknown and malformed bindings fail closed. Runtime credential
resolution and deployment preflight are separate work; see the
[Encore Alignment Roadmap](./encore-alignment-roadmap.md).

## Document

The [application resource model](./application-resource-model.md) declares what
an application needs. `supacloud.environments.json` declares where those logical
resources should be resolved, without embedding connection strings or secrets:

```json
{
  "schema": "supacloud.environments.v1",
  "environments": {
    "fast": {
      "bindings": {
        "orders-db": "local",
        "attachments": "local"
      }
    },
    "integration": {
      "bindings": {
        "orders-db": "project:orders",
        "attachments": "bucket:attachments"
      }
    }
  }
}
```

Environment names match `^[a-z][a-z0-9-]{0,31}$`. Binding values must match the
entire reference grammar: `local`, or a single `scheme:name` namespace
(`^[a-z][a-z0-9-]{0,15}:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`). URLs, credentials,
whitespace and control characters, including a trailing newline, are rejected.
Secret values must be referenced by name, for example `secret:orders-db`.
A reference's syntax is not proof of its existence or authorization.

## Command and path ownership

```sh
supacloud-compiler environment-bindings [rootDir] --environment <name> [--bindings-file <file>] [--json]
```

`--environment` is required; the CLI never selects the first object key as an
environment. The command is read-only and rejects `--write`.

When an explicit `rootDir` (or `--root`) is supplied, the default binding document
and any relative `--bindings-file` are resolved against that directory. With no
explicit root, they are resolved against the current project directory. Absolute
binding-file paths are used as given. This prevents a command targeting a nested
project from silently reading the parent workspace's binding file. When selecting
a source subdirectory, use `--bindings-file` to explicitly identify a document
outside that directory.

```sh
supacloud-compiler environment-bindings ./apps/orders --environment integration --json
supacloud-compiler environment-bindings ./apps/orders --environment integration --bindings-file config/bindings.json
```

The CLI returns nonzero for binding diagnostics, analysis errors, invalid files
or exceeded budgets. Rejected JSON and IO error bodies are never echoed.

## Projection

`supacloud.environment-bindings.v1` contains the selected `environment`, sorted
`bindings` (`resource`, `kind`, `binding`), `omitted.resources`, and `limits`.
JSON CLI output additionally includes `diagnostics`; programmatic resolution
returns `{ projection, diagnostics }`. Ordering uses an explicit locale.
Only own properties are read: prototype properties are not declarations.

## Diagnostics

| Code | Name | Meaning |
| --- | --- | --- |
| SC8106 | `missing-environment-binding` | A declared resource lacks a binding |
| SC8107 | `unknown-environment-binding` | A binding names an undeclared resource |
| SC8108 | `invalid-environment-binding` | A reference is malformed or credential-shaped |

Unknown environments produce `ENVIRONMENT_BINDINGS_UNKNOWN_ENVIRONMENT`.
Malformed documents produce `ENVIRONMENT_BINDINGS_INVALID`; budget violations
produce `ENVIRONMENT_BINDINGS_TOO_LARGE`.

## Limits

Documents allow at most 32 environments and 128 bindings per environment. File
reads are bounded to 4 MiB of actual bytes before strict UTF-8 decoding and JSON
parsing. Programmatic parsing also bounds and detaches the document; resolution
revalidates it so subsequent mutations cannot bypass validation.

The projection contains at most 64 bindings, with omissions explicitly counted.
Both formatted JSON (including diagnostics) and human-readable output must fit
64 KiB of UTF-8, including the final newline. Multibyte resource names and error
messages count toward the same budget. Oversized output fails before printing;
it is not silently truncated into a partial successful result.

## Local runtime classification

```sh
supacloud-compiler environment-bindings ./apps/orders --environment fast --profile fast --json
```

`--profile fast|integration` produces `supacloud.runtime-bindings.v1` with
`credentials: "resolved-by-local-runner"`. `local` is classified as `ephemeral`;
a valid namespaced reference is `external`. The `fast` profile rejects every
non-local declaration, including declarations beyond the 64-entry display cap.
`integration` accepts local and external references but does not connect to them.
Both output formats enforce a separate 64 KiB budget after classification.

Production-shaped environment names (`prod`, `production`, `live`, `release`,
optionally followed by `-` or `_`) are rejected before project configuration is
loaded. Production-shaped reference destinations are also rejected during
resolution with `ENVIRONMENT_BINDINGS_PRODUCTION_FORBIDDEN`. These syntax checks
are not proof that an arbitrary reference is non-production: the future runner
must independently authorize and identify the destination before connecting.

## Boundaries and next steps

Only explicit resources are resolved; dynamic SQL, arbitrary `fetch`, and SDK
calls are not inferred. Nothing connects to or mutates an environment. A binding
is a declaration, not a runtime credential, health check, or permission proof.

Connecting these classifications to local runners, deployment preflight, and
delivery receipts referencing the resolved binding version remain separate
implementation slices.
