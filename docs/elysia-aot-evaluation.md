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

## Function Publish Option

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
- Edge candidates pass HTTP health identity and internal metrics authorization
  with runtime-only configuration and initialized Workers.
- A Function fixture retains 401 authorization, 422 body validation, runtime
  environment access, byte-exact prebundled upload, SHA and activation identity.
- A Function AOT bundle passes Management's prebundled normalization unchanged.
- Management capture warns that 23 coercion/codec validator slots may produce
  coarser 422 error details. This is a compatibility risk requiring API replay.

This is build/smoke evidence, not a production latency, memory, throughput, or
full Management API parity result. Management requires a test database and
authenticated API replay before promotion. No merge or deployment is implied.

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
