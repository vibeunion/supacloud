import starterMetadata from "./starter-metadata.json" with { type: "json" };
import { STARTER_ENVIRONMENT, STARTER_ENVIRONMENT_TEST } from "./app-starter-environment";

const { compiler: compilerMetadata, app: appMetadata, elysia: elysiaMetadata } = starterMetadata.packages;

export type StarterTemplate = "minimal" | "command" | "model-command";
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

const APPLICATION_SOURCE = (name: string): string => `import { createApplication } from "@supacloud/elysia";
import { createSupAuthRequestContext, type SupAuthContextOptions, type ApplicationOptions, type CommandGovernance } from "@supacloud/elysia";
import { createCompiledModules } from "../generated/application";

export interface AppAdapters {
  deps: NonNullable<ApplicationOptions["deps"]>;
  requestContext: NonNullable<ApplicationOptions["requestContext"]>;
  commandGovernance: CommandGovernance;
  onExecution?: NonNullable<ApplicationOptions["onExecution"]>;
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

export function baseTemplateFiles(name: string, sdkDependencies: StarterSdkDependencies): Record<string, string> {
  return {
    "package.json": json({
      name, version: "0.0.0", private: true, type: "module",
      engines: { bun: ">=1.4.4" },
      scripts: {
        compile: "bun --no-env-file node_modules/@supacloud/compiler/dist/cli.js compile",
        "check:generated": "bun --no-env-file node_modules/@supacloud/compiler/dist/cli.js check",
        typecheck: "tsc --noEmit",
        inspect: "bun --no-env-file node_modules/@supacloud/compiler/dist/cli.js graph --json",
        check: "bun run compile && bun run check:generated && bun run typecheck && bun run test",
        test: "bun run compile && bun --no-env-file scripts/environment.ts test bun test",
        dev: "bun --no-env-file scripts/environment.ts development bun scripts/dev.ts",
        build: "bun run compile && bun run typecheck && bun build src/application.ts --target bun --minify --outdir output/supacloud",
        "env:development": "bun --no-env-file scripts/environment.ts development",
        "env:test": "bun --no-env-file scripts/environment.ts test",
        "env:staging": "bun --no-env-file scripts/environment.ts staging",
        "env:production": "bun --no-env-file scripts/environment.ts production",
      },
      dependencies: {
        "@supacloud/app": `^${appMetadata.version}`,
        "@supacloud/elysia": `^${elysiaMetadata.version}`,
        effect: "4.0.5",
        elysia: "2.0.0-rc.1",
        ...sdkDependencies,
      },
      devDependencies: {
        "@supacloud/compiler": `^${compilerMetadata.version}`,
        "@types/bun": "^1.4.4",
        typescript: "7.1.0-beta",
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
    ".gitignore": ["node_modules/", "dist/", "output/supacloud/", ".env", ".env.*", "!.env.*.example", "!.env.test", ""].join("\n"),
    ".env.development.example": "APP_ENV=development\nPORT=3000\n",
    ".env.test": "APP_ENV=test\n",
    ".env.staging.example": "APP_ENV=staging\n# Inject credentials using the deployment platform.\n",
    ".env.production.example": "APP_ENV=production\n# Inject credentials using the deployment platform.\n",
    "supacloud.config.ts": `import { defineSupacloudConfig } from "@supacloud/compiler";

export default defineSupacloudConfig();
`,
    "src/application.ts": APPLICATION_SOURCE(name),
    "generated/application.ts": GENERATED_BOOTSTRAP,
    "scripts/environment.ts": STARTER_ENVIRONMENT,
    "tests/environment.test.ts": STARTER_ENVIRONMENT_TEST,
    "scripts/dev.ts": DEV_SCRIPT,
    "scripts/serve.ts": SERVE_SCRIPT,
  };
}

function minimalTemplate(name: string, sdkDependencies: StarterSdkDependencies): Record<string, string> {
  return {
    ...baseTemplateFiles(name, sdkDependencies),
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
- Start with \`supacloud app context --format json\` and \`supacloud app doctor --format json\`.
  Do not scan the whole repository first or treat generated/ as source.
- Apply only reviewed diagnostic fixes with \`supacloud app fix --fix <file>\`, then
  re-run check and doctor. Never weaken compiler governance to hide a diagnostic.
- Run the directly related single test file and git diff --check for daily changes.
- Use \`supacloud app verify-plan --target <module>\` to inspect the focused verification plan.
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
project with app init --template command. Do not install every recipe into this
application.

## Integration and delivery

createApp requires application-owned trusted identity and durable adapters.
\`bun run build\` emits \`output/supacloud/application.js\`, not a deployed server.
Keep this backend directory separate from frontend output such as \`dist/\`,
which frontend tools may clean and publish. Do not disable frontend cleanup to
preserve backend artifacts; use disjoint output directories.
Database migrations and seed data require an explicitly selected development
database and a reviewed application script; the CLI never infers a production target.
Commit generated/ after compilation. At release, check generated drift before
regeneration, then validate types, database permissions and authenticated behavior.
`,
  };
}

/** New projects use the minimal layout; the command recipe is emitted separately. */
export function appTemplateFiles(name: string, template: "minimal", sdkDependencies: StarterSdkDependencies): Record<string, string> {
  if (template !== "minimal") throw new Error("Use appStarterFiles for the command recipe");
  return minimalTemplate(name, sdkDependencies);
}
