# Compiler Inference and Rust Boundaries

## Status

Implemented as a read-only `InferencePlan` in `@supacloud/compiler`.

```bash
supacloud app infer --format json
supacloud app doctor --format json
supacloud app context --format json
```

The same plan is available to the CLI, generators and AI context. It is based on
the current `ApplicationGraph`; it does not execute application code, inspect
credentials or mutate a database.

## Readiness

Inference is deliberately divided into three levels:

- `safe`: structural facts can be applied without a business decision. Examples:
  a unique root module and a route parameter whose name exactly matches a path
  segment.
- `confirm`: the compiler found candidates, but more than one interpretation is
  possible. Examples: multiple top-level modules and an unbound non-path
  handler parameter.
- `never`: the value is a business or trust decision. Permissions, tenant/RLS
  policy, database ownership, external retry policy and production migrations
  remain explicit inputs.

`app infer` is read-only. `app doctor` reports the counts and the next command.
`app generate` may use a unique root module both as the registration target for
module/resource/feature scaffolds and as the `--module` value for command/query/
controller/job/contract scaffolds. Ambiguous projects still require explicit
`--register-in` or `--module`.

The plan also reports two non-structural boundaries:

- `module.imports`: when a module injects a token that exactly one other module
exports and it does not import that module, inference proposes an
`add_module_import` fix. It stays `confirm` because module composition changes,
so generators and agents must review it rather than apply it silently.
- `database.operationOwnership`: table operation ownership is never derived from
an application Command or route name. It is `never` here and lives in
`db/modules.ts`; use `supacloud db operation-ownership suggest` and
`adopt` for evidence-based classification.

The JSON payload includes a `commands` map (infer, context, check, doctor,
verifyPlan, ownershipSuggest, ownershipAdopt) so agents do not need to guess
the next command.

## Rust boundary manifest

Rust services built with the shared `supacloud-runtime-core` expose the
versioned `supacloud.rust-boundary.v1` manifest model. The manifest records the
service, engine, capabilities, routes and logical resources. It is descriptive
metadata, not an authorization or deployment proof.

The JIT gateway exposes this metadata at `/manifest`. Rust services must continue
to call the existing Command, RPC or Management API boundary for governed writes;
the manifest does not create a second database, queue or policy pipeline.
