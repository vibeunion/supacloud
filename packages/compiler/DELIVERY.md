# Local Delivery Planning And Builds

`supacloud-compiler plan --json` is a read-only first step toward automated app
delivery. It uses the existing source analysis and compiler checks, then groups
HTTP routes and declared Jobs into deterministic target previews.

`supacloud-compiler build-delivery --json` additionally builds independent local
module factory bundles, or runnable HTTP applications with explicitly configured
hosts. It does **not** configure queues or gateways, verify remote
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

By default, `bundle/index.js` exports `createCompiledModules`. Move the whole `bundle` directory,
not just its entrypoint. The generated TypeScript is inspection output and still
references application sources; the bundle does not require those source files.
This default is **not** an HTTP handler or a ready-to-deploy Function. A compatible
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
Unresolved computed `import()` and direct computed `require()` calls are rejected;
the literal-only import-helper exception is described below. This is not a sandbox
for arbitrary JavaScript, eval, or filesystem access.

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

Each target bundles in a fresh Bun subprocess rooted at the application project,
isolating dependency resolution from the caller's analysis process and working
directory. The compiler package includes the internal worker entrypoint; do not
copy only `dist/index.js` or `dist/cli.js`. A typed internal protocol returns the
artifact bytes and original input hashes. Failure, cancellation or the five-minute
per-target limit does not publish a new manifest. Cancellation reaps the worker;
the worker also watches its caller so an abruptly terminated caller does not leave
it running. These are build-process controls, not application deployment controls.

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
Only an atomic replacement of `delivery.manifest.json` publishes the selected local build.
Failures preserve the previous active pointer; inactive objects can remain after
an interrupted publication. Removed target objects are retained for inspection,
not automatically garbage-collected. Inspect stale locks after confirming no
writer is active; the builder never removes them automatically.

## Runnable HTTP Applications

For an HTTP target, explicitly supply a trusted host composition module:

```json
{
  "version": 1,
  "build": {
    "httpApplications": [
      { "target": "api", "source": "delivery-host.ts" }
    ]
  }
}
```

`source` is a TypeScript file relative to the configured source root. It must
export `createDeliveryApplication(modules, lifecycle)` returning, synchronously
or asynchronously, `{ fetch(request): Response | Promise<Response>, close() }`.
The compiler type-checks this contract and bundles the host and its dependencies
together with that target's compiled modules. Duplicate hosts, unknown targets,
Job targets, missing files, symlinks and paths into generated output are rejected.

For a stateless, public HTTP application:

```ts
import { createApplication, type CompiledModule } from "@supacloud/elysia";

export function createDeliveryApplication(
  modules: CompiledModule[],
  { signal }: { signal: AbortSignal },
) {
  signal.throwIfAborted();
  const app = createApplication({ modules });
  return {
    fetch: (request: Request) => app.handle(request),
    close() {},
  };
}
```

Business applications must additionally supply their real identity, database,
governance and other adapters here. No memory or anonymous-identity fallback is
added by the compiler. Pass the supplied modules through to the runtime; importing
another generated application or manually adding routes bypasses target ownership.
The host is trusted application code, not a sandbox, and build success cannot
prove that its exposed routes or security policy match the plan.

Move the **entire** `bundle` directory to the destination and run:

```sh
HOST=127.0.0.1 PORT=3000 bun --no-env-file bundle/index.js
```

HTTP objects have `entryKind: "bun-http-application"`; their entry is an executable
that starts the listener, not an import-only module factory. Targets without a
host keep `entryKind: "compiled-module-factory"`. All object kinds still report
`deploymentReady: false`: a local build neither activates a service nor verifies
its environment, migrations, health, credentials, isolation or recovery.
HTTP object identities bind their executable discriminator; existing factory
object hashes remain readable. Old compiler versions reject the new kind.

The listener defaults to loopback port 3000; `PORT=0` selects an ephemeral test
port. It emits a JSON `delivery-http-listening` event with its listener URL, not
a health or deployment receipt. Environment files are not loaded by the documented
command. Runtime environment values are not inlined into the bundle.

SIGINT/SIGTERM abort `lifecycle.signal`, including during initialization. A host
that allocates resources before returning must handle cancellation and clean up
before rejecting; top-level import side effects are outside this lifecycle.
On shutdown the listener drains requests, then closes the host once. Half of
`SHUTDOWN_TIMEOUT_MS` (default 10000, range 1-300000) is available for graceful
draining before force-closing connections. Forced drain is reported as failure,
even if host cleanup finishes. The full deadline bounds initialization cancellation
and host cleanup; expiry exits nonzero without claiming cleanup succeeded.
Startup, listener and shutdown failures use generic messages; the host remains
responsible for sanitizing its own logging and responses.

## Runnable Workers

Job targets can explicitly bind a worker host:

```json
{
  "version": 1,
  "runtime": {
    "processIsolation": true,
    "durableQueue": true,
    "capabilities": []
  },
  "build": {
    "workerApplications": [
      { "target": "jobs", "source": "worker-host.ts" }
    ]
  }
}
```

Runtime capabilities describe the selected infrastructure, not proof that it is
active or healthy. Only declare a durable queue after selecting and configuring
the actual queue adapter. The compiler does not create one.

The source must export `createDeliveryWorker(modules, lifecycle)` returning
`{ start(), close() }`, synchronously or asynchronously. Both methods may return
`void` or `Promise<void>`. The factory prepares the trusted host; `start` begins
polling; `close` stops new claims, awaits in-flight execution and settlement, and
releases owned resources. These responsibilities belong to the host, typically
using the existing `createWorker` API, not to a second compiler-owned queue loop.
Do not begin consuming work in the factory or a top-level import.

Hosts may additionally expose `failure: Promise<never>` for fatal background
errors consumed by their worker/transport layer. It must stay pending during
healthy operation and graceful shutdown, and reject when manual recovery or
process replacement is required. The entry observes it before invoking start,
performs bounded cleanup and exits nonzero without printing the rejection.
Unexpected fulfillment also fails the process. Rejecting this channel does not
settle queue messages: the transport still owns receipt/recovery semantics.

The compiler type-checks the host against the target's compiled modules. Worker
hosts require Job targets; HTTP hosts require HTTP targets. Duplicate bindings,
invalid source paths, symlinks and generated-output sources fail without replacing
the previous local manifest. Worker objects bind
`entryKind: "bun-worker-application"` into their immutable identity and can run
with `bun --no-env-file bundle/index.js`. Existing factory and HTTP object hash
formats remain readable; older compilers cannot read the new worker kind.

The executable emits `{"event":"delivery-worker-started"}` only after `start`
resolves. This is neither a queue-health receipt nor activation attestation.
The process stays alive until shutdown even when the host has no active timers.
SIGINT/SIGTERM abort `lifecycle.signal`, including during factory/start execution.
If cancellation happens before `start`, polling is not started. Once the factory
returns, cancellation calls `close` exactly once, even while `start` is pending.
The host must support that overlap, stop pending acquisition/polling and await
its own in-flight work. A successful exit waits for both start and close to settle;
an unresponsive start still times out even if close has returned. Factories must
handle cancellation and clean up their resources before rejecting.
Runtime side effects in imports remain outside this contract.

`SHUTDOWN_TIMEOUT_MS` has the same default and range as the HTTP entry. Its deadline
bounds cancellation and cleanup; expiry exits nonzero, not successful recovery.
Startup failures attempt bounded cleanup before exiting nonzero. Uncaught host
exceptions and unhandled promise rejections, including abort-listener failures,
trigger failed shutdown without printing their contents. The entry yields once
after cleanup to observe queued abort errors before reporting graceful exit.
Host-owned logging/error handlers and errors already consumed by a worker
observer still require their own sanitization and supervision policy.

Detached compiler tests and packed starter smoke verify compiled Job execution,
receipt handling and shutdown using a deterministic test transport. They do not
prove a durable queue, production credentials, business replay, migrations,
activation, rollback or data recovery. `deploymentReady` remains `false`.

The bundler expands private, single-return import helpers only if every reference
is a direct call with one literal module specifier. Exported/escaped helpers,
nonliteral arguments and other computed loads remain rejected. Original source
bytes stay in the input snapshot. Emitted imports are checked separately from
input metadata because Bun can mark eliminated re-exports or optional missing
dependencies as external.

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

## Build-Associated Execution Context

New build objects contain `bundle/execution-context.json`, a target-projected,
sanitized execution snapshot included in their immutable file inventory.
`context <subject> --delivery-manifest <saved-manifest> --delivery-target <target>
--events <metadata> --request-id <id> --json` verifies the selected object's
inventory and correlates observations to that snapshot without loading current
project configuration or source. The observation envelope must identify the
same `delivery: { target, objectId }`.

Archive the matching manifest alongside its `objects` directory. A mismatched
identity, missing snapshot, changed file, extra file or symlink fails closed;
there is no fallback to the current graph. The reader is bounded to 1 MiB JSON,
1,024 artifact files, 64 MiB per file and 128 MiB total, with the existing 32 KiB
context output limit.

`artifactVerified: true` establishes local content consistency only. The selected
manifest and caller-supplied event identity are not authenticated runtime
attestations; `eventsTrusted` and `deploymentVerified` stay false. Hosts still own
metadata collection, naming, retention and access control. See
`docs/execution-context.md` for the envelope and interpretation boundaries.

## Migration Artifact Identity

`readDeliveryMigrationArchive(manifestPath, target)` loads a target without source
checkout. It verifies the entire immutable inventory and hashed target metadata,
then validates the bounded migration manifest, executor-specific paths and exact
SQL bytes. Its return value includes SQL for trusted tooling; do not log or expose
it as an AI context response. An archive without declared migrations returns an
empty list, not a claim that the application requires no database provisioning.
Artifact integrity does not attest who built it or where it is deployed.

The CLI's `database delivery_migration_plan` uses this reader with the dedicated
read-only Management API inventory endpoint. It prints identity checks rather
than SQL, never executes migrations, and keeps operator provisioning separate.

`delivery.build.migrations` explicitly declares application SQL inputs. Sources
are relative to the application project containing `tsconfig.json`, unlike host
and asset sources which are relative to the configured source root:

```json
{
  "version": 1,
  "build": {
    "migrations": [
      {
        "source": "migrations/001-review.sql",
        "version": "1",
        "name": "review",
        "executor": "project-migration"
      },
      {
        "source": "migrations/004-review-runtime-roles.sql",
        "version": "4",
        "name": "review_runtime_roles",
        "executor": "operator-provisioning"
      }
    ]
  }
}
```

All targets in this project contract carry the same selected application
migrations. A migration byte, version, name or executor change invalidates their
immutable identity even when executable bytes do not change. The build does not
scan migration directories or silently include undeclared SQL.

Inputs require unique canonical positive signed-64-bit versions, unique sources,
portable names and an explicit executor declaration. SQL sources must be regular,
non-symlinked UTF-8 files inside the project, outside generated output and
dependency directories. Limits are 128 declarations, 1 MiB per file and 16 MiB
total. Blank or invalid UTF-8 inputs fail without switching the previous build.
The SQL is archived verbatim, including line endings; no parser rewrites it.

Each object includes `bundle/migrations.json` and files under
`bundle/migrations/project-migration/` or
`bundle/migrations/operator-provisioning/`, named `<version>_<name>.sql`.
The inventory records raw-byte SHA-256 and size, plus `compatibility: "not-proven"`,
`executionPerformed: false` and `dataRecovery: "separate-required"`.
The execution flag describes the build operation, not whether a target database
has already applied any migration; that requires a selected environment's ledger.

These hashes are not the canonical platform ledger checksum of normalized
version/name/statements. Do not compare them as if they were the same identity.
Reconciliation, risk review, authorization and execution remain owned by the
existing platform migration APIs. The executor field declares intended handling;
it cannot bypass platform SQL policy or grant database privileges. Platform
runtime prerequisites are separately managed, not implicitly bundled.
Building an archive is not evidence of backward compatibility, applied migrations,
successful activation, application rollback or recovered data.
