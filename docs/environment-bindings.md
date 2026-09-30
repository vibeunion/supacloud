# Environment Bindings

Status: **IMPLEMENTED (static resolution slice)**. The compiler reads a
per-environment binding document, resolves each declared `@InfraResource` to an
opaque reference and fails closed on missing, unknown or credential-shaped
bindings. Runtime credential resolution and deployment preflight are **not**
implemented here; see [Encore Alignment Roadmap](./encore-alignment-roadmap.md).

## Why

The [application resource model](./application-resource-model.md) declares
*what* infrastructure an application needs (`orders-db`, `attachments`) without
saying where it comes from. An environment binding answers the next question —
"which concrete binding does this logical resource use in this environment?" —
without moving credentials or hosting decisions into the application source or
build output.

The projection is a read-only view of the declarations plus one binding
document. It is not a second source of truth and it does not prove that a target
environment actually provides the resource.

## Document

`supacloud.environments.json` at the project root:

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

- `schema` is exactly `supacloud.environments.v1`.
- `environments` maps an environment name (`^[a-z][a-z0-9-]{0,31}$`) to its
  `bindings`.
- `bindings` maps a logical resource name to an opaque binding reference.

A binding reference is either `local` or a single `scheme:name` namespace
(`^[a-z][a-z0-9-]{0,15}:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`). It never carries a
connection string, URL, credential or secret value: values containing `://`,
`@`, `=`, whitespace or control characters are rejected. Secrets must be
referenced by name (`secret:orders-db`), not inlined.

## Command

```sh
supacloud-compiler environment-bindings [rootDir] --environment <name> [--bindings-file <file>] [--json]
```

The command analyzes the current source (read-only), resolves the selected
environment and prints the projection. `--bindings-file` defaults to
`./supacloud.environments.json`. The process exits non-zero when any binding
diagnostic is reported, so CI fails closed.

Add `--profile fast|integration` to resolve the **local runtime** projection
(`supacloud.runtime-bindings.v1`):

```sh
supacloud-compiler environment-bindings --environment fast --profile fast --json
```

Runtime resolution only classifies the static projection for a local runner; it
never resolves a credential (`credentials: "resolved-by-local-runner"`). The
`fast` profile requires every resource to bind to `local` (mode `ephemeral`);
`integration` accepts namespaced references (mode `external`). A
production-shaped environment name (`prod`, `production`, `live`, `release`) is
refused with `ENVIRONMENT_BINDINGS_PRODUCTION_FORBIDDEN` before anything is read,
so a local entry can never point at production by accident.

## Projection

`supacloud.environment-bindings.v1`:

| Field | Contents |
| --- | --- |
| `environment` | The resolved environment name |
| `bindings` | resource, declared kind and binding reference, sorted by resource |
| `omitted` | resources beyond the cap |
| `limits` | enforced caps |
| `diagnostics` | `--json` output only; `{ code, severity, environment, resource?, message }` |

## Diagnostics

| Code | Name | Meaning |
| --- | --- | --- |
| SC8106 | `missing-environment-binding` | A declared `@InfraResource` has no binding in the selected environment |
| SC8107 | `unknown-environment-binding` | The environment binds a name that is not a declared `@InfraResource` |
| SC8108 | `invalid-environment-binding` | A binding reference is a URL, credential or otherwise malformed |

When the selected environment does not exist, the command fails with
`ENVIRONMENT_BINDINGS_UNKNOWN_ENVIRONMENT`. A structurally invalid document
fails with `ENVIRONMENT_BINDINGS_INVALID`; exceeding the caps fails with
`ENVIRONMENT_BINDINGS_TOO_LARGE`.

## Limits

`ENVIRONMENT_BINDINGS_LIMITS` bounds the document at 32 environments, 128
bindings per environment and a 64 KiB projection budget. The `resources` cap
(64) bounds the emitted projection and is reported through `omitted`.

## Boundaries

- **Declaration vs runtime.** A binding reference says where a resource *should*
  be resolved. It is not a credential, a connection test or a permission check.
  Runtime resolution, permissions and health remain deployment preflight.
- **Explicit references only.** Dynamic SQL, arbitrary `fetch` and third-party
  SDKs are not inferred. Only declared `@InfraResource` names are resolved.
- **Fail closed.** Missing, unknown or credential-shaped bindings are errors,
  not first-request failures.
- **No production side effects.** The resolver only reads a local document; it
  never connects to or mutates an environment.

## Next steps

1. Wire the runtime projection into the local runner so `fast` starts against
   ephemeral resources and `integration` connects to explicitly selected ones.
2. Deployment preflight that verifies the bound resource, permissions and health.
3. Delivery/receipt evidence referencing the resolved binding version.