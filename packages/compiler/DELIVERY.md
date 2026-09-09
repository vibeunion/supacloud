# Local Delivery Planning And Builds

`supacloud-compiler plan --json` is a read-only first step toward automated app
delivery. It uses the existing source analysis and compiler checks, then groups
HTTP routes and declared Jobs into deterministic target previews.

`supacloud-compiler build-delivery --json` additionally builds independent local
module factory bundles. It does **not** configure queues or gateways, verify remote
hosts, deploy functions, or run an unattended AI repair loop.
Existing compile/check/dev output remains unchanged.

## Zero-Configuration HTTP

```sh
supacloud-compiler plan --json
```

All discovered HTTP routes default to `api`. Module imports contribute dependencies,
not route ownership. A dependency module's own routes remain with their own explicit
owner or the default API; they are not copied into the importing target.
All discovered routes remain exposed in the plan. To make a module private, remove
its route declarations; simply omitting a module from target configuration does not
hide its routes.

Declared Jobs default to `jobs`, require a durable queue declaration, and default
to process isolation. A Job declaration does not rewrite a synchronous HTTP route.
If these runtime declarations are absent, planning returns errors with no plan.

## Explicit Boundaries

Add an optional `delivery` section to the existing configuration:

```ts
import { defineSupacloudConfig } from "@supacloud/compiler";

export default defineSupacloudConfig({
  delivery: {
    version: 1,
    targets: [
      { name: "orders", kind: "api", modules: ["orders"] },
      {
        name: "payment-hooks",
        kind: "webhook",
        modules: ["payments"],
        isolation: "process",
        capabilities: ["payments.verify"],
      },
    ],
    runtime: {
      processIsolation: true,
      durableQueue: true,
      capabilities: ["payments.verify"],
    },
  },
});
```

The names in `modules` are declared module names, not class names or paths.
Targets select all routes or all jobs belonging to those modules, depending on
their kind. HTTP and Job ownership are independent, so one module can contribute
HTTP to `api` and Jobs to `jobs`. Two HTTP targets cannot both own the same module.
`api` and `jobs` are reserved for their matching workload kinds.

No unused explicit target is accepted. Unknown modules, duplicate ownership,
unresolved imports, cyclic dependencies, duplicate job names, and conflicting
method/path patterns reject the plan. Parameter-name aliases such as `/:id` and
`/:key` do not establish different route identities.

`runtime` is a declaration only, not host attestation. `capabilities` contains
adapter/credential boundary references, never values. Declaring a webhook target
does not implement signature verification or authorize public ingress. The runtime
and deployment layers must still verify these requirements before activation.
Changing `isolation` to `shared` is an explicit relaxation requiring user review.

For an AI-generated JSON declaration instead of editing executable config:

```sh
supacloud-compiler plan --delivery delivery.json --json
```

`delivery.json` contains the `delivery` object above, not the outer project config.
It replaces, rather than merges with, `config.delivery`. The executable project
config is still loaded normally. Invalid configuration is rejected, not echoed.
`--write` and unknown plan arguments fail. Successful output exits 0; failures exit 1.

## Programmatic Contract

```ts
import {
  compileOptionsFromConfig,
  loadSupacloudConfig,
  planDeliveryProject,
  parseDeliveryPlanResult,
} from "@supacloud/compiler";

const config = await loadSupacloudConfig();
const result = await planDeliveryProject(compileOptionsFromConfig(config), config.delivery);
if (result.ok) {
  for (const target of result.plan.targets) {
    console.log(target.name, target.routes, target.requirements);
  }
}

// File/message data must be validated, not asserted as DeliveryPlanResult.
const received: unknown = JSON.parse(JSON.stringify(result));
const validated = parseDeliveryPlanResult(received);
console.log(validated.ok);
```

Exported TypeBox schemas are the source of both runtime validation and static types:
`DeliveryOptionsSchema`, `DeliveryTargetSchema`, `DeliveryPlanSchema`,
`DeliveryPlanResultSchema`. `createDeliveryPlan` accepts a trusted compiler graph;
it is not a deserializer for arbitrary external graph JSON.

## Local Builds

```sh
supacloud-compiler build-delivery --json
supacloud-compiler build-delivery --delivery delivery.json --json
```

Requires Bun and a project `tsconfig.json`. The configured output directory must
be project-local and must not contain the application source root. Output uses
the dedicated `<outDir>/delivery` namespace:

```text
delivery/
  owner.json
  delivery.manifest.json
  objects/<objectId>/
    generated/application.ts
    bundle/index.js
    bundle/package.json
    bundle/app.manifest.json
    bundle/target.json
    bundle/assets/...
```

`bundle/index.js` exports `createCompiledModules`. Move the whole `bundle` directory,
not just its entrypoint. The generated TypeScript is inspection output and still
references application sources; the bundle does not require those source files.
This is **not** a default HTTP handler or a ready-to-deploy Function. A compatible
host must supply HTTP composition, trusted identity, database/governance adapters,
and durable Job execution. Route mappings are local metadata, not applied gateway
configuration. All results continue to report `deploymentReady: false`.

Optional build settings live in the same validated `delivery` declaration:

```json
{
  "version": 1,
  "build": {
    "minify": true,
    "environmentContract": "app-env-v1",
    "assets": [
      { "target": "api", "source": "templates/report.html", "path": "report.html" }
    ]
  }
}
```

Asset `source` is relative to configured source root; `path` is relative to
`bundle/assets`. Only explicit relative paths are accepted. Missing assets, path
traversal, duplicate destinations, and symlinks reject the build. Environment
contracts are references, not secret values. Environment values are not inlined.
Code doing runtime filesystem reads must use declared assets and the host's
documented asset-location convention; automatic discovery is not provided.
Computed `import()` and direct computed `require()` calls are rejected. This is
not a sandbox for arbitrary JavaScript, eval, or filesystem access.

Each target includes its conservative module dependency closure, while route and
Job descriptors remain exclusive to their owner. Provider pruning is disabled to
preserve Job and lifecycle dependencies. Package imports are bundled; only Bun
and Node builtin imports may remain external. Native/platform-dependent packages
still need destination-platform validation.

Every invocation reruns compiler checks, TypeScript diagnostics, and bundling for
**all** targets. The generator's type-check project includes application source
and target-generated files, preserving configured checks and widening only the
emit-path `rootDir` to the project directory. This does not replace application
tests or full release checks. Refresh GraphQL artifacts through normal `compile`
before building when GraphQL drift is reported.

`inputDigest` includes generated source, captured bundled inputs, compiler and Bun
identity, configuration/lockfile hashes, target build options, explicit assets,
and environment-contract reference. Shared dependency changes invalidate dependent
targets; configuration changes conservatively invalidate more targets. Unchanged
immutable artifacts are reused without touching their files. This is **artifact
reuse, not skipped bundler work**.

Success exposes `manifest`, `bundledTargets`, `changedTargets`, `unchangedTargets`,
`removedTargets`, and `written`. An unchanged build has `written: []`.
`manifest.objects` records per-file size and SHA-256 plus the object identity.
Use `parseDeliveryBuildResult` / `parseDeliveryBuildManifest` for received JSON;
matching hashes are integrity checks, not authorization or authenticity proofs.

An exclusive lock protects the owned output directory. Existing unowned output,
invalid manifests, and modified immutable objects are rejected without overwrites.
Only an atomic replacement of `delivery.manifest.json` activates a local build.
Failures preserve the previous active pointer; inactive objects can remain after
an interrupted publication. Removed target objects are retained for inspection,
not automatically garbage-collected. Inspect stale locks after confirming no
writer is active; the builder never removes them automatically.

## Planning Evidence And Limits

- Every result has `written: []`. A failure has `ok: false` and `plan: null`.
- Success has `deploymentReady: false`. No planning result authorizes deployment.
- `topologyDigest` hashes canonical target topology, requirements, and declared
  readiness. It excludes business source contents, toolchain, lockfile, credentials,
  migrations, and full runtime contracts. It is **not** an artifact hash, cache key,
  approval token, or proof that a received plan is authentic.
- Dependencies are a conservative module closure, not provider-level tree shaking.
  External token inventory is conservative within that closure.
- `planDeliveryProject` runs existing compiler analysis/governance/contract gates
  using supplied compile options. Artifact drift is intentionally ignored so a
  new project can be planned before generation. Existing artifacts are not rewritten.
- Compiler analysis is not a complete TypeScript type check. Run the application's
  type checker, tests, full integration/build gates, and host verification before
  release. Do not weaken those gates to make a plan succeed.
- This version does not reconcile old deployment topology, validate all possible
  router-specific pattern overlaps, or attest queue adapters. Deployment remains
  a separate, explicitly authorized step.
