import starterMetadata from "./starter-metadata.json" with { type: "json" };
import { STARTER_REACTIVE_GUIDE, STARTER_REACTIVE_TEST, STARTER_REACTIVE_AGENTS } from "./app-starter-reactive";
import { STARTER_ENVIRONMENT, STARTER_ENVIRONMENT_TEST } from "./app-starter-environment";

const { compiler: compilerMetadata, app: appMetadata, elysia: elysiaMetadata } = starterMetadata.packages;

export type StarterTemplate = "minimal" | "http" | "command" | "edge";
export interface StarterSdkDependencies {
  "@supacloud/js": string;
  "@supabase/supabase-js": string;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const DEV_SCRIPT = `import { watchProject, compileOptionsFromConfig, loadSupacloudConfig } from "@supacloud/compiler";

if (process.env["APP_ENV"] !== "development") throw new Error("The demo server is development-only");
let server: ReturnType<typeof Bun.spawn> | undefined;
let restarts = Promise.resolve();
let closing = false;
const watcher = watchProject({
  ...compileOptionsFromConfig(await loadSupacloudConfig()),
  writeOnError: false,
  onEvent: (event) => {
    if (event.type === "compile-error") console.error(event.diagnostics);
    if (event.type !== "compiled") return;
    restarts = restarts.then(async () => {
      if (server) { server.kill(); await server.exited; }
      if (closing) return;
      server = Bun.spawn([process.execPath, "--no-env-file", "scripts/serve.ts"], {
        stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env,
      });
    }).catch((error) => { console.error(error); process.exitCode = 1; });
  },
});
const close = async () => {
  closing = true;
  await watcher.close();
  await restarts;
  if (server) { server.kill(); await server.exited; }
  process.exit(0);
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
await watcher.ready;
`;

const SERVE_SCRIPT = `import { createDemo } from "./sandbox";

if (process.env["APP_ENV"] !== "development") throw new Error("The demo server is development-only");
const port = Number(process.env["PORT"] ?? "3000");
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid PORT");
const sandbox = createDemo();
const server = Bun.serve({
  hostname: "127.0.0.1", port,
  fetch: (request) => sandbox.app.handle(request),
});
console.log("Local demo: " + server.url);
`;

const APPLICATION_SOURCE = (name: string): string => `import { createApplication, createSupAuthRequestContext, type SupAuthContextOptions, type ApplicationOptions, type CommandGovernance } from "@supacloud/elysia";
import { createCompiledModules } from "../generated/application";

export interface AppAdapters {
  deps: NonNullable<ApplicationOptions["deps"]>;
  requestContext: NonNullable<ApplicationOptions["requestContext"]>;
  commandGovernance: CommandGovernance;
  onExecution?: ApplicationOptions["onExecution"];
}

// The host verifies external identity (SupAuth for unified login) before creating requestContext.
export function createApp(adapters: AppAdapters) {
  const { onExecution, ...rest } = adapters;
  return createApplication({
    ...rest,
    ...(onExecution === undefined ? {} : { onExecution }),
    name: ${JSON.stringify(name)},
    modules: createCompiledModules(),
  });
}

export function createSupAuthApp(identity: SupAuthContextOptions, adapters: Omit<AppAdapters, "requestContext">) {
  return createApp({ ...adapters, requestContext: createSupAuthRequestContext(identity) });
}
`;

const GENERATED_BOOTSTRAP = `// BOOTSTRAP ARTIFACT: bun run compile replaces this file.
// Keeping a typed placeholder lets the first compile resolve the application entrypoint.
export function createCompiledModules(): never {
  throw new Error("Run bun run compile before starting the application");
}
`;

function baseFiles(name: string, sdkDependencies?: StarterSdkDependencies): Record<string, string> {
  const minimal = sdkDependencies !== undefined;
  return {
    "package.json": json({
      name, version: "0.0.0", private: true, type: "module",
      engines: { bun: ">=1.4.2" },
      scripts: {
        compile: "bun --no-env-file node_modules/@supacloud/compiler/dist/cli.js compile",
        "check:generated": "bun --no-env-file node_modules/@supacloud/compiler/dist/cli.js check",
        typecheck: "tsc --noEmit",
        inspect: "bun --no-env-file node_modules/@supacloud/compiler/dist/cli.js graph --json",
        check: "bun run compile && bun run check:generated && bun run typecheck && bun run test",
        test: "bun run compile && bun --no-env-file scripts/environment.ts test bun test",
        dev: "bun --no-env-file scripts/environment.ts development bun scripts/dev.ts",
        build: "bun run compile && bun run typecheck && bun build src/application.ts --target bun --minify --outdir dist",
        "env:development": "bun --no-env-file scripts/environment.ts development",
        "env:test": "bun --no-env-file scripts/environment.ts test",
        "env:staging": "bun --no-env-file scripts/environment.ts staging",
        "env:production": "bun --no-env-file scripts/environment.ts production",
      },
      dependencies: {
        "@supacloud/app": `^${appMetadata.version}`,
        "@supacloud/elysia": `^${elysiaMetadata.version}`,
        effect: "4.0.2",
        elysia: "2.0.0-beta.21",
        ...(sdkDependencies ?? { rxjs: appMetadata.dependencies.rxjs }),
      },
      devDependencies: {
        "@supacloud/compiler": `^${compilerMetadata.version}`,
        "@types/bun": "^1.4.2",
        typescript: "^7.0.2",
      },
    }),
    "tsconfig.json": json({
      compilerOptions: {
        target: "ES2022", module: "ESNext", moduleResolution: "bundler",
        strict: true, experimentalDecorators: true, skipLibCheck: true,
        noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
        noImplicitOverride: true, noPropertyAccessFromIndexSignature: true,
        noFallthroughCasesInSwitch: true, forceConsistentCasingInFileNames: true,
        useUnknownInCatchVariables: true,
        noEmit: true, types: ["bun"],
      },
      include: ["src/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts", "generated/**/*.ts", "supacloud.config.ts"],
    }),
    "bunfig.toml": "env = false\n",
    ".gitignore": ["node_modules/", "dist/", ".env", ".env.*", "!.env.*.example", "!.env.test", ""].join("\n"),
    ".env.development.example": "APP_ENV=development\nPORT=3000\n",
    ".env.test": "APP_ENV=test\n",
    ".env.staging.example": "APP_ENV=staging\n# Inject credentials using the deployment platform.\n",
    ".env.production.example": "APP_ENV=production\n# Inject credentials using the deployment platform.\n",
    "supacloud.config.ts": `import { defineSupacloudConfig } from "@supacloud/compiler";

export default defineSupacloudConfig({
  root: "src",
  outDir: "generated",
  strict: true,
  moduleBoundaryPreset: "modular-monolith",
  effect: {
    requireRouteEffects: true,
    requireErrorMappings: true,
    requireDependencies: true,
    requireTaggedErrorTypes: true,
    requireExactDependencyTypes: true,
    requireTimeoutForDependencies: true,
    forbidDirectRuntimeExecution: true,
    forbidDirectThrows: true,
  },
  typeSafety: { scanProductionSource: true, noAnyInGenerated: true },
  disallowControllerDirectDb: true,
  detectOrphanModules: true,
  commandCapabilities: { permission: true, transaction: true, idempotency: true, audit: true },
});
`,
    "src/application.ts": APPLICATION_SOURCE(name),
    "generated/application.ts": GENERATED_BOOTSTRAP,
    ...(minimal ? {} : {
      "REACTIVE.md": STARTER_REACTIVE_GUIDE,
      "AGENTS.md": STARTER_REACTIVE_AGENTS,
      "tests/reactive.test.ts": STARTER_REACTIVE_TEST,
    }),
    "scripts/environment.ts": STARTER_ENVIRONMENT,
    "tests/environment.test.ts": STARTER_ENVIRONMENT_TEST,
    "scripts/dev.ts": DEV_SCRIPT,
    "scripts/serve.ts": SERVE_SCRIPT,
  };
}

function httpTemplate(name: string): Record<string, string> {
  return {
    ...baseFiles(name),
    "src/orders/contracts.ts": `import { t } from "elysia";
export const OrderParams = t.Object({ id: t.String({ minLength: 1 }) });
export const CreateOrderBody = t.Object({ name: t.String({ minLength: 1 }) });
export const OrderResult = t.Object({ id: t.String(), name: t.String() });
export const HealthResult = t.Object({ ok: t.Boolean() });
`,
    "src/orders/orders.ts": `import { Effect } from "effect";
import { Body, Controller, Get, Param, Post, defineFeatureSlice } from "@supacloud/app";
import { status } from "elysia";
import { OrderParams, CreateOrderBody, OrderResult, HealthResult } from "./contracts";
@Controller("/orders")
export class OrdersController {
  @Get("/health", {
    responses: { 200: HealthResult },
    effect: { required: true, dependencies: [], errors: [], retry: "none" },
  })
  health(): Effect.Effect<{ ok: boolean }, never, never> { return Effect.succeed({ ok: true }); }

  @Get("/:id", {
    params: OrderParams,
    responses: { 200: OrderResult },
    effect: { required: true, dependencies: [], errors: [], retry: "none" },
  })
  get(@Param("id") id: string): Effect.Effect<{ id: string; name: string }, never, never> {
    return Effect.succeed({ id, name: "demo" });
  }

  @Post("/", {
    body: CreateOrderBody,
    responses: { 201: OrderResult },
    effect: { required: true, dependencies: [], errors: [], retry: "none" },
  })
  create(@Body() body: { name: string }) {
    return Effect.succeed(status(201, { id: "demo", name: body.name }));
  }
}

export const OrdersFeature = defineFeatureSlice({
  name: "orders",
  tags: ["type:feature"],
  controllers: [OrdersController],
});
`,
    "scripts/sandbox.ts": `import { createMemorySandbox } from "@supacloud/elysia";
import { createCompiledModules } from "../generated/application";

export function createDemo() {
  if (process.env["APP_ENV"] !== "development" && process.env["APP_ENV"] !== "test") {
    throw new Error("Memory adapters are restricted to development and test");
  }
  return createMemorySandbox({
    modules: createCompiledModules(),
    identity: { authenticated: true, subject: "local-demo" },
  });
}
`,
    "tests/orders.test.ts": `import { expect, test } from "bun:test";
import { createDemo } from "../scripts/sandbox";

test("health, read and create routes follow the declared HTTP contract", async () => {
  const sandbox = createDemo();
  expect((await sandbox.request("/orders/health")).status).toBe(200);
  expect((await sandbox.request("/orders/1")).status).toBe(200);
  const created = await sandbox.request("/orders", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "first" }),
  });
  expect(created.status).toBe(201);
  expect(await created.json()).toEqual({ id: "demo", name: "first" });
  const invalid = await sandbox.request("/orders", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  });
  expect(invalid.status).toBe(422);
});
`,
    "README.md": `# ${name}

HTTP API golden path.

## Local Development

\`\`\`sh
bun install
bun run check
bun run dev
\`\`\`

The server binds only to 127.0.0.1:3000 by default.

\`\`\`sh
curl http://127.0.0.1:3000/orders/health
curl http://127.0.0.1:3000/orders/1
curl -X POST http://127.0.0.1:3000/orders \\
  -H 'Content-Type: application/json' -d '{"name":"first"}'
\`\`\`

The generated feature declares explicit route schemas so the compiler can detect
route/schema drift. Keep request and response shapes in \`src/orders/orders.ts\`;
do not widen them to \`unknown\` just to accept unvalidated data.

## Production Boundary

\`bun run build\` emits an application factory, not a server. Import \`createApp\`
from \`dist/application.js\` in your trusted host and supply real dependency,
request-context and command-governance adapters. The memory sandbox is
development/test only.

## Inspection And Repair

\`\`\`sh
supacloud context --root . --target orders --format json
supacloud doctor --root .
\`\`\`
`,
  };
}

function edgeTemplate(name: string): Record<string, string> {
  return {
    ...baseFiles(name),
    "src/sync/sync.ts": `import { Injectable, Job, defineFeatureSlice } from "@supacloud/app";

/**
 * Worker/edge golden path: a declared, retry-bounded job with an explicit
 * idempotency requirement. The platform owns scheduling, retry and DLQ; the
 * handler stays side-effect explicit and must not assume exactly-once execution.
 */
@Injectable()
@Job({
  name: "sync.orders",
  mode: "task",
  idempotency: "required",
  timeoutSec: 60,
  maxAttempts: 3,
})
export class SyncOrdersJob {
  async run(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}

export const SyncFeature = defineFeatureSlice({
  name: "sync",
  tags: ["type:feature"],
  providers: [SyncOrdersJob],
  jobs: [SyncOrdersJob],
});
`,
    "scripts/sandbox.ts": `import { createMemorySandbox } from "@supacloud/elysia";
import { createCompiledModules } from "../generated/application";

export function createDemo() {
  if (process.env["APP_ENV"] !== "development" && process.env["APP_ENV"] !== "test") {
    throw new Error("Memory adapters are restricted to development and test");
  }
  return createMemorySandbox({
    modules: createCompiledModules(),
    identity: { authenticated: true, subject: "local-worker" },
  });
}
`,
    "tests/sync.test.ts": `import { expect, test } from "bun:test";
import { SyncOrdersJob } from "../src/sync/sync";

test("the declared job handler is deterministic and idempotent by construction", async () => {
  const job = new SyncOrdersJob();
  expect(await job.run()).toEqual({ ok: true });
  expect(await job.run()).toEqual({ ok: true });
});
`,
    "README.md": `# ${name}

Worker / Edge golden path.

## Local Development

\`\`\`sh
bun install
bun run check
bun run test
\`\`\`

\`src/sync/sync.ts\` declares a platform job with an explicit mode, timeout,
attempt bound and idempotency requirement. The platform schedules and retries;
the handler must be safe to run more than once and must not assume exactly-once
execution.

## Production Boundary

The job runs through the platform worker/edge adapter, not the local memory
sandbox. Bind persistence, authorization and audit to durable adapters before
invoking it in production. Do not schedule destructive work without an
idempotency key.

## Inspection And Repair

\`\`\`sh
supacloud context --root . --target sync --format json
supacloud doctor --root .
\`\`\`
`,
  };
}

function minimalTemplate(name: string, sdkDependencies: StarterSdkDependencies): Record<string, string> {
  return {
    ...baseFiles(name, sdkDependencies),
    "src/features/health/contracts.ts": `import { t } from "elysia";
export const HealthResult = t.Object({ ok: t.Boolean() });
`,
    "src/features/health/health.ts": `import { Effect } from "effect";
import { Controller, Get, Module } from "@supacloud/app/core";
import { HealthResult } from "./contracts";
@Controller("/health")
export class HealthController {
  @Get("/", {
    responses: { 200: HealthResult },
    effect: { required: true, dependencies: [], errors: [], retry: "none" },
  })
  health(): Effect.Effect<{ ok: boolean }, never, never> { return Effect.succeed({ ok: true }); }
}

@Module({ name: "health", tags: ["type:feature"], controllers: [HealthController] })
export class HealthModule {}
`,
    "src/features/health/health.test.ts": `import { Effect } from "effect";
import { expect, test } from "bun:test";
import { HealthController } from "./health";

test("health is a public, side-effect-free operation", async () => {
  expect(await Effect.runPromise(new HealthController().health())).toEqual({ ok: true });
});
`,
    "src/app.module.ts": `import { Module } from "@supacloud/app/core";
import { HealthModule } from "./features/health/health";

@Module({ name: "application-root", tags: ["type:app"], imports: [HealthModule] })
export class AppModule {}
`,
    "scripts/sandbox.ts": `import { createMemorySandbox } from "@supacloud/elysia";
import { createCompiledModules } from "../generated/application";

export function createDemo() {
  if (process.env["APP_ENV"] !== "development" && process.env["APP_ENV"] !== "test") {
    throw new Error("Local adapters are restricted to development and test");
  }
  return createMemorySandbox({ modules: createCompiledModules() });
}
`,
    "AGENTS.md": `# Application changes

- Business code and its tests belong in src/features/<feature>.
- Use @supacloud/app/core for metadata; keep UI in the selected frontend framework.
- Reuse @supacloud/js and the existing Supabase session for platform access.
- Ordinary reads use the RLS-protected Supabase client. GraphQL is opt-in.
- Cross-table business writes require trusted authorization, transactions,
  idempotency and audit. Never put service-role or Management tokens in a browser.
- Do not edit generated/. Do not rewrite historical migrations.
- Run the directly related single test file and git diff --check for daily changes.
- Use app verify-plan --target <module> to inspect the focused verification plan.
- Do not introduce another workflow engine, DI container or session store.
`,
    "README.md": `# ${name}

## Local development

\`\`\`sh
bun install
bun run compile
bun test src/features/health/health.test.ts
bun run dev
\`\`\`

The local server binds to 127.0.0.1:3000 and exposes GET /health.
The dev script compiles, watches and restarts after successful compilation.
Memory adapters are local-only; this is not production identity or persistence.

## Add a feature

Keep code, contracts and tests in src/features/<feature>; register modules in
src/app.module.ts. Use @supacloud/app/core, not a frontend compatibility API.
Use app generate --kind resource for an authorized read-port skeleton.
It fails closed until the application supplies its data adapter.

## Frontend and database

@supacloud/js wraps your existing @supabase/supabase-js client. Reuse its session,
Storage and RLS-protected PostgREST reads. Generated business clients can use
createAuthenticatedFetch from @supacloud/js/contracts with that same session.
Use fixed trusted HTTPS endpoints and never retry an uncertain write.

GraphQL is optional; this starter has no synthetic GraphQL schema.
For a complete persistent command/attachment example, create a separate reference
project with app init --template command. The http and edge recipes also remain
explicit options; do not install every recipe into this application.

## Integration and delivery

createApp requires application-owned trusted identity and durable adapters.
Database migrations and seed data require an explicitly selected development
database and a reviewed application script; the CLI never infers a production target.
Commit generated/ after compilation. At release, check generated drift before
regeneration, then validate types, database permissions and authenticated behavior.
`,
  };
}

/** Explicit recipes retain their existing layouts; new projects default to minimal. */
export function appTemplateFiles(name: string, template: StarterTemplate, sdkDependencies?: StarterSdkDependencies): Record<string, string> {
  if (template === "minimal") {
    if (!sdkDependencies) throw new Error("Minimal template requires the initializer's SDK dependency versions");
    return minimalTemplate(name, sdkDependencies);
  }
  if (template !== "http" && template !== "edge") throw new Error("Use appStarterFiles for the command recipe");
  const files = template === "http" ? httpTemplate(name) : edgeTemplate(name);
  const feature = template === "http" ? "OrdersFeature" : "SyncFeature";
  const source = template === "http" ? "./orders/orders" : "./sync/sync";
  return {
    ...files,
    "src/app.module.ts": `import { Module } from "@supacloud/app";
import { ${feature} } from "${source}";

// Compose feature modules here. Do not make unrelated features import each other.
@Module({
  name: "application-root",
  tags: ["type:app"],
  imports: [${feature}],
})
export class AppModule {}
`,
    "README.md": files["README.md"] + `
## Application Composition

\`src/app.module.ts\` is the application composition root. Register additional
feature modules there, rather than importing them from another feature.
The compiler discovers this declaration; no runtime container lookup is needed.

With the matching candidate/released CLI installed:

\`\`\`sh
supacloud-cli app generate --kind resource --name inventory --register-in src/app.module.ts --dry-run --format json
supacloud-cli app generate --kind resource --name inventory --register-in src/app.module.ts
bun run check
bun run inspect
\`\`\`

The resource is an asynchronous read skeleton, not implemented CRUD. Its Service
rejects until an authorized data adapter is supplied; implement it and replace the
placeholder test together. Generation does not grant access or connect a database.

\`bun run inspect\` delegates to the installed compiler and prints the current
source graph as JSON without starting the app or regenerating artifacts. This is
not a live mounted-route report. Configuration remains trusted project code.
After changing source, compile before using artifact-backed CLI graph/explain.

In CI, run \`bun run check:generated\` before commands that regenerate artifacts;
\`bun run check\` is the convenient bootstrap path for a newly created project.
`,
  };
}
