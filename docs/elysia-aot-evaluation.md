# Opt-in Elysia AOT Evaluation

Elysia AOT moves route-handler/validator generation into the build. It is not
native compilation of arbitrary user JavaScript, Bun bytecode, or a change to
JavaScriptCore's JIT policy. Default platform builds and Function deployments
remain unchanged.

## Platform A/B Builds

From the repository root, after installing the selected package's dependencies
(and `packages/delivery` dependencies for Management API):

```sh
bun --no-env-file scripts/elysia-aot-ab.ts management-api /tmp/management-aot-ab
bun --no-env-file scripts/elysia-aot-ab.ts edge-runtime /tmp/edge-aot-ab
```

Each command produces `<component>-plain.js` and `<component>-aot.js`. Run with
Bun using the same **test** configuration for both candidates. These are ESM
evaluation bundles, not release binaries. Package scripts `build:aot:ab` expose
the same workflow. No default release script is changed.

The AOT candidate captures the fixed exported app in a separate process with
an environment allowlist, nonexistent configuration-file paths, dummy loopback
database/API endpoints, and a 120-second timeout. Edge capture does not create
Function directories, start Workers, listen, or start runtime monitors. Both
Edge candidates embed the same ordinary Worker bundle; tenant modules are not
captured. This process separation is **not a security sandbox**.

Use the same Bun/dependency versions for comparison. `strip: false` retains
Elysia's runtime code-generation fallback. `production: false` avoids forcing
Elysia's production flag at build time. `env: "disable"` avoids substituting
application environment values into the output.

Before promotion, compare route registration, authorization, validation/status
and error payloads, WebSocket behavior, activation/preheat, and representative
Function dispatch. Environment-dependent route registration must match at
capture and runtime. Health/version checks alone do not prove API parity.

## Experimental Function Publish Option

Unlike the platform A/B tooling, this explicitly requested CLI option publishes
an artifact through the ordinary deployment API. It is not enabled by default.
Replay the Function's authentication, validation, status/error payloads and
application behavior against a non-AOT build before production use. In particular,
coercion/codec schemas can change validation error detail. Read-only mode rejects
AOT deployment before importing local application code.

```sh
supacloud-cli edge_functions deploy --ref abc123 --slug hello \
  --path ./functions/hello/index.ts --framework elysia --aot \
  --expected-active-version absent --expected-activation-id legacy
```

The entry must export an Elysia app as `app` or default. If a wrapper exports a
fetch handler instead, use `--aot-entry ./functions/hello/app.ts`; this module
must be reachable from the handler's bundle graph. `--minify` applies locally.
`--aot false` uses the existing deployment path.

The CLI invokes Bun in a separate process and resolves the plugin from the
Function's installed Elysia, not from the CLI. The resulting single ESM bundle
is hashed and sent through the existing `prebundled: true` API. The Management
API still validates SHA-256/runtime policy and rejects byte-changing
normalization. Activation CAS, immutable versions, rollback, and preheat are
unchanged. AOT is a publish option, not persisted runtime configuration.

Only trusted local/CI source may use this option: AOT imports the app and runs
its initialization. The child does not inherit CLI/API credentials or load
`.env` automatically, but it can still access local files/network or explicitly
load files. Keep credentials, environment-dependent registration, listeners,
timers, and external I/O out of capture initialization. Guard runtime-only
startup with `process.env.ELYSIA_AOT_BUILD !== "1"` when necessary. Handlers
must read tenant credentials at runtime. Module initialization still occurs
when the published bundle is loaded; AOT does not remove all cold-start work.

Inline source, prebundled input, `deploy_bundle`, other frameworks, and other
actions cannot enable this option. Custom bundler plugins/import-map handling
are not added here. Apps needing them can build in their own trusted pipeline
and use the existing verified `--prebundled-path` workflow. Compiler delivery
schemas and server-side user-code execution are not changed.

## Local Evidence

Validated with Bun 1.4.3 on macOS arm64 and platform Elysia 2.0.0-beta.21:

- Management and Edge plain/AOT bundles build with manifest-injection checks.
- Management plain/AOT HTTP replay covers validation/coercion, malformed JSON,
  storage parse envelopes, authentication, route-not-found, `AppError` status
  mappings, multipart upload, streaming, OpenAPI JSON, and WebSocket echo
  (`bun test packages/management-api/tests/unit/elysia-aot-http-parity.test.ts`,
  25 scenarios).
- Edge candidates pass HTTP health identity and internal metrics authorization
  with runtime-only configuration and initialized Workers.
- A Function fixture retains 401 authorization, 422 body validation, runtime
  environment access, byte-exact prebundled upload, SHA and activation identity.
- A Function AOT bundle passes Management's prebundled normalization unchanged.
- Management capture warns that 23 coercion/codec validator slots may produce
  coarser 422 error details. The sampled replay scenarios show no public contract
  difference because the Management error hook intentionally returns the stable
  `400 Validation failed` envelope. Keep the replay as a release gate.

This is build/smoke evidence, not a production latency, memory, throughput, or
full Management API parity result. The replay is side-effect-free and does not
replace database-backed, authenticated full API acceptance. No merge or
deployment is implied.

The parity fixtures are a typed route plugin mounted on the real Management app;
they reuse its production error hooks without executing business writes.
Management's package typecheck excludes tests, so check the new fixtures and
test explicitly from `packages/management-api`:

```sh
./node_modules/.bin/tsc --ignoreConfig --noEmit --strict --skipLibCheck \
  --moduleResolution bundler --module ESNext --target ES2022 \
  src/types/sql.d.ts src/types/shell.d.ts src/types/jsonl.d.ts \
  tests/fixtures/aot-http-parity-app.ts tests/fixtures/aot-http-parity-build.ts \
  tests/fixtures/aot-http-parity-entry.ts tests/unit/elysia-aot-http-parity.test.ts
```

Before promotion, replay authenticated database-backed workflows against isolated
test data in both candidates, compare their public contracts, and measure cold
startup, warm latency, throughput, and memory under the same workload. Keep plain
builds as the default until these gates pass; the probe replay alone is not
production approval.

## Current-Main Review Evidence

Additional review on Linux x64, Bun 1.4.3 and Elysia 2.0.0-rc.0:

- The CLI suite passes 155 tests, including minified and unminified AOT runtime
  auth/validation, runtime and module-initialization environment values, parent
  credential/`.env` isolation, disconnected app rejection, exact upload SHA/CAS,
  and rejecting AOT in read-only mode before local execution.
- Both generated Function variants pass Management's normalization byte-for-byte.
- Both platform A/B pairs build. Edge capture isolation tests reject any attempt
  to instantiate a Worker or listener and verify no Function directory is created.
- Both Edge bundles pass the same 30 activation/config/CORS tests, including
  attested artifact/symlink rejection, activation fencing, restart identity,
  authenticated dispatch and preflight behavior.
- A focused Management exported-app replay matches all 747 registered method/path
  entries and nine status/body responses: version, missing/invalid/master auth,
  provider data, invalid numeric coercion queries, metrics auth and missing paths.
  This is **not** a database-backed or comprehensive authenticated API replay.
- The committed 25-scenario Management HTTP replay also passes on this version,
  including malformed JSON, storage envelopes, runtime-only authentication,
  AppError mappings, multipart upload, streaming, OpenAPI JSON and probe WebSocket
  echo. These probes use real app hooks but do not exercise business writes.
- Current Management capture warns about **24** coercion/codec validator slots.
  The sampled global validation responses match, but the warning is not waived.
  Database-backed business behavior, real authenticated/business WebSocket flows
  and full API parity remain unverified. Probe echo coverage does not waive them.

The Edge suites can be replayed without changing the fixtures after building:

```sh
bun --no-env-file test scripts/elysia-aot-ab.test.ts
for mode in plain aot; do
  SUPACLOUD_EDGE_TEST_ENTRYPOINT=/tmp/edge-aot-ab/edge-runtime-$mode.js \
    bun --no-env-file test packages/edge-runtime/server-function-config.test.ts \
      packages/edge-runtime/server-options-preflight.test.ts
done
```

These results support continued experimental evaluation only. They do not promote
AOT to the platform defaults or establish production readiness.

## Acceptance Scenarios

1. Given AOT is absent or false, when deploying a Function, then existing
   bundling, syntax checks, and activation behavior are unchanged.
2. Given trusted Elysia source and AOT enabled, when publishing, then a separate
   local process captures the reachable app and uploads exact SHA-verified bytes.
3. Given incompatible source/action options or a disconnected app entry, when
   publishing, then it fails before the deployment HTTP request.
4. Given a platform A/B build, when capturing Edge routes, then no tenant module,
   Worker, listener, or runtime monitor starts during capture.
5. Given an AOT bundle, when handling runtime requests, then auth, validation,
   and environment values remain runtime-bound; behavioral differences block
   production promotion.
