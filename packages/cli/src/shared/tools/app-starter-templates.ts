import { STARTER_ENVIRONMENT, STARTER_ENVIRONMENT_TEST } from "./app-starter-environment";
import compilerMetadata from "../../../../compiler/package.json" with { type: "json" };
import appMetadata from "../../../../app/package.json" with { type: "json" };
import elysiaMetadata from "../../../../elysia/package.json" with { type: "json" };

export type StarterTemplate = "http" | "command" | "edge";

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const DEV_SCRIPT = `import { watchProject, compileOptionsFromConfig, loadSupacloudConfig } from "@supacloud/compiler";

if (process.env.APP_ENV !== "development") throw new Error("The demo server is development-only");
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

if (process.env.APP_ENV !== "development") throw new Error("The demo server is development-only");
const port = Number(process.env.PORT ?? "3000");
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
  return createApplication({
    ...adapters,
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

function baseFiles(name: string): Record<string, string> {
  return {
    "package.json": json({
      name, version: "0.0.0", private: true, type: "module",
      engines: { bun: ">=1.4.2" },
      scripts: {
        compile: "bun --no-env-file node_modules/@supacloud/compiler/dist/cli.js compile",
        "check:generated": "bun --no-env-file node_modules/@supacloud/compiler/dist/cli.js check",
        typecheck: "tsc --noEmit",
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
        elysia: "^1.4.30",
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
  typeSafety: { scanProductionSource: true, noAnyInGenerated: true },
  disallowControllerDirectDb: true,
  detectOrphanModules: true,
  commandCapabilities: { permission: true, transaction: true, idempotency: true, audit: true },
});
`,
    "src/application.ts": APPLICATION_SOURCE(name),
    "generated/application.ts": GENERATED_BOOTSTRAP,
    "scripts/environment.ts": STARTER_ENVIRONMENT,
    "tests/environment.test.ts": STARTER_ENVIRONMENT_TEST,
    "scripts/dev.ts": DEV_SCRIPT,
    "scripts/serve.ts": SERVE_SCRIPT,
  };
}

function httpTemplate(name: string): Record<string, string> {
  return {
    ...baseFiles(name),
    "src/orders/orders.ts": `import { Body, Controller, Get, Param, Post, defineFeatureSlice } from "@supacloud/app";
import { t } from "elysia";

export const OrderParams = t.Object({ id: t.String({ minLength: 1 }) });
export const CreateOrderBody = t.Object({ name: t.String({ minLength: 1 }) });
export const OrderResult = t.Object({ id: t.String(), name: t.String() });
export const HealthResult = t.Object({ ok: t.Boolean() });

@Controller("/orders")
export class OrdersController {
  @Get("/health", { responses: { 200: HealthResult } })
  health(): { ok: boolean } { return { ok: true }; }

  @Get("/:id", { params: OrderParams, responses: { 200: OrderResult } })
  get(@Param("id") id: string): { id: string; name: string } { return { id, name: "demo" }; }

  @Post("/", { body: CreateOrderBody, responses: { 201: OrderResult } })
  create(@Body() body: { name: string }): { id: string; name: string } { return { id: "demo", name: body.name }; }
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
  if (process.env.APP_ENV !== "development" && process.env.APP_ENV !== "test") {
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
  if (process.env.APP_ENV !== "development" && process.env.APP_ENV !== "test") {
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

/** Golden-path project templates other than the default full `command` starter. */
export function appTemplateFiles(name: string, template: StarterTemplate): Record<string, string> {
  return template === "http" ? httpTemplate(name) : edgeTemplate(name);
}