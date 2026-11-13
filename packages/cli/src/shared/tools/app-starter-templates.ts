import starterMetadata from "./starter-metadata.json" with { type: "json" };
import { STARTER_ENVIRONMENT, STARTER_ENVIRONMENT_TEST } from "./app-starter-environment";

const { compiler: compilerMetadata, app: appMetadata, elysia: elysiaMetadata } = starterMetadata.packages;

/** Canonical init templates. Unknown values fail closed. */
export const STARTER_TEMPLATES = ["minimal", "client", "command", "model-command"] as const;
export type StarterTemplate = (typeof STARTER_TEMPLATES)[number];

/** Forced vibecoding default: compiler, Elysia, and @supacloud/app. */
export const DEFAULT_STARTER_TEMPLATE = "minimal" satisfies StarterTemplate;

/** Explicit data-plane-only scaffold. Never the default. */
export const CLIENT_STARTER_TEMPLATE = "client" satisfies StarterTemplate;

/**
 * Accepted CLI aliases. `app` was the 2518 name for the compiler stack and
 * resolves to `minimal` so packed smoke scripts keep working.
 */
export const STARTER_TEMPLATE_ALIASES = {
  app: "minimal",
} as const satisfies Readonly<Record<string, StarterTemplate>>;

export type StarterTemplateInput = StarterTemplate | keyof typeof STARTER_TEMPLATE_ALIASES;

export interface StarterSdkDependencies {
  "@supacloud/js": string;
  "@supabase/supabase-js": string;
}

export function isStarterTemplate(value: string): value is StarterTemplate {
  return (STARTER_TEMPLATES as readonly string[]).includes(value);
}

/** Resolve CLI/API input to a canonical template. Undefined selects the forced default. */
export function resolveStarterTemplate(input: string | undefined): StarterTemplate {
  if (input === undefined) return DEFAULT_STARTER_TEMPLATE;
  if (isStarterTemplate(input)) return input;
  if (Object.hasOwn(STARTER_TEMPLATE_ALIASES, input)) {
    return STARTER_TEMPLATE_ALIASES[input as keyof typeof STARTER_TEMPLATE_ALIASES];
  }
  throw new Error(
    `Unknown app init template: ${input}. Use ${STARTER_TEMPLATES.join(", ")}`
    + " (`app` is accepted as an alias of `minimal`).",
  );
}

function assertNeverTemplate(value: never): never {
  throw new Error(`Unhandled starter template: ${String(value)}`);
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
import {
  createSupAuthRequestContext,
  type SupAuthContextOptions,
  type CommandGovernance,
  type ExecutionObserver,
} from "@supacloud/elysia";
import { createCompiledModules } from "../generated/application";

/** Trusted-host adapters. Keep these explicit so indexed ApplicationOptions access cannot widen to any. */
export interface AppAdapters {
  deps: Record<string, unknown>;
  requestContext: (
    request: Request,
    context: unknown,
    signal?: AbortSignal,
  ) => unknown | Promise<unknown>;
  commandGovernance: CommandGovernance;
  onExecution?: ExecutionObserver;
}

export interface CreatedApplication {
  fetch: (request: Request) => Promise<Response>;
  handle: (request: Request) => Promise<Response>;
  initialize: () => Promise<void>;
  destroy: () => Promise<void>;
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null;
}

function isApplicationHost(value: unknown): value is {
  fetch: (request: Request) => Response | Promise<Response>;
  handle: (request: Request) => Response | Promise<Response>;
  initialize: () => void | Promise<void>;
  destroy: () => void | Promise<void>;
} {
  return isRecord(value)
    && typeof value["fetch"] === "function"
    && typeof value["handle"] === "function"
    && typeof value["initialize"] === "function"
    && typeof value["destroy"] === "function";
}

function isRequestContextFactory(value: unknown): value is AppAdapters["requestContext"] {
  return typeof value === "function";
}

export function readCreatedApplication(value: unknown): CreatedApplication {
  if (!isApplicationHost(value)) {
    throw new Error("createApplication returned an invalid application host");
  }
  return {
    fetch: async (request) => await value.fetch(request),
    handle: async (request) => await value.handle(request),
    initialize: async () => { await value.initialize(); },
    destroy: async () => { await value.destroy(); },
  };
}

// The host verifies external identity (SupAuth for unified login) before creating requestContext.
export function createApp(adapters: AppAdapters): CreatedApplication {
  const application: unknown = createApplication({
    deps: adapters.deps,
    requestContext: adapters.requestContext,
    commandGovernance: adapters.commandGovernance,
    name: ${JSON.stringify(name)},
    modules: createCompiledModules(),
    ...(adapters.onExecution === undefined ? {} : { onExecution: adapters.onExecution }),
  });
  return readCreatedApplication(application);
}

export function createSupAuthApp(
  identity: SupAuthContextOptions,
  adapters: Omit<AppAdapters, "requestContext">,
): CreatedApplication {
  const resolved: unknown = createSupAuthRequestContext(identity);
  if (!isRequestContextFactory(resolved)) {
    throw new Error("createSupAuthRequestContext must return a requestContext function");
  }
  return createApp({ ...adapters, requestContext: resolved });
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
        elysia: "2.0.0-rc.4",
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

const DATA_CLIENT = `import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Official data-plane client. Provisioned projects are reached with this client. */
export function createDataClient(input: { url: string; anonKey: string }): SupabaseClient {
  const url = new URL(input.url);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Use the project HTTPS API URL, or loopback HTTP for local development");
  }
  if (input.anonKey.trim().length < 8 || input.anonKey !== input.anonKey.trim()) {
    throw new Error("Use the anon or publishable key");
  }
  return createClient(url.toString(), input.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
`;

const DATA_CLIENT_TEST = `import { expect, test } from "bun:test";
import { createDataClient } from "../src/client";

test("the data client is the official supabase-js client", () => {
  const client = createDataClient({ url: "http://127.0.0.1:54321", anonKey: "public-anon-key" });
  expect(typeof client.from).toBe("function");
  expect(typeof client.channel).toBe("function");
});

test("non-local http URLs are rejected", () => {
  expect(() => createDataClient({ url: "http://example.com", anonKey: "public-anon-key" })).toThrow("HTTPS");
});
`;

/** Explicit `--template client`: official supabase-js only. Not the default. */
function supabaseClientTemplate(name: string, sdkDependencies: StarterSdkDependencies): Record<string, string> {
  return {
    "package.json": json({
      name, version: "0.0.0", private: true, type: "module",
      engines: { bun: ">=1.4.4" },
      scripts: {
        typecheck: "tsc --noEmit",
        test: "bun test",
        check: "bun run typecheck && bun run test",
      },
      dependencies: {
        "@supabase/supabase-js": sdkDependencies["@supabase/supabase-js"],
      },
      devDependencies: {
        "@types/bun": "^1.4.4",
        typescript: "7.1.0-beta",
      },
    }),
    "tsconfig.json": json({
      compilerOptions: {
        target: "ES2022", module: "ESNext", moduleResolution: "bundler",
        strict: true, skipLibCheck: true,
        noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
        noImplicitOverride: true, noPropertyAccessFromIndexSignature: true,
        noFallthroughCasesInSwitch: true, forceConsistentCasingInFileNames: true,
        useUnknownInCatchVariables: true,
        noEmit: true, types: ["bun"],
      },
      include: ["src/**/*.ts", "tests/**/*.ts"],
    }),
    "bunfig.toml": "env = false\n",
    ".gitignore": ["node_modules/", ".env", ".env.*", "!.env.example", ""].join("\n"),
    ".env.example": "SUPABASE_URL=http://127.0.0.1:54321\nSUPABASE_ANON_KEY=replace-with-anon-or-publishable-key\n",
    "src/client.ts": DATA_CLIENT,
    "tests/client.test.ts": DATA_CLIENT_TEST,
    "AGENTS.md": `# ${name}

This project talks to a provisioned Supabase-compatible API with
\`@supabase/supabase-js\`. It is the explicit \`--template client\` scaffold.

- Do not add \`@supacloud/app\`, \`@supacloud/compiler\`, \`@supacloud/elysia\`, or \`effect\` here.
- The forced default application stack is \`supacloud app init\` (\`minimal\`).
- Durable SQL and model recipes are \`--template command\` and \`--template model-command\`.
- Use the anon or publishable key. Never put a service-role or Management token in this client.
- Management API provision does not compile this project and does not interpret Effect.
`,
    "README.md": `# ${name}

Explicit data-plane client (\`supacloud app init --template client\`) for a
provisioned project. This scaffold depends on \`@supabase/supabase-js\` only. It
does not install \`@supacloud/app\`, the compiler, Elysia, or Effect.

## Local check

\`\`\`sh
bun install
bun test tests/client.test.ts
bun run check
\`\`\`

Copy \`.env.example\` and set \`SUPABASE_URL\` to the project API URL and
\`SUPABASE_ANON_KEY\` to the anon or publishable key. Do not commit the filled
file, and do not put the service-role key in this client.

\`createDataClient\` accepts HTTPS, or HTTP only for \`127.0.0.1\` and \`localhost\`.
Realtime uses the same client's \`channel()\` against the project's
\`/realtime/v1/websocket\` endpoint. See the platform Realtime contract for which
process owns that socket.

## Default application stack

\`supacloud app init\` (template \`minimal\`) is the forced compiler + Effect
project. \`--template command\` and \`--template model-command\` are the durable
reference recipes. Do not add those dependencies to this client project.
`,
  };
}

function appFrameworkTemplate(name: string, sdkDependencies: StarterSdkDependencies): Record<string, string> {
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

Default application stack from \`supacloud app init\` (template \`minimal\`).
It installs \`@supacloud/app\`, the compiler, Elysia, and Effect. The data-plane
client remains \`@supabase/supabase-js\` inside this project. Use
\`--template client\` only when you need a client-only directory.

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

/** `minimal` is the forced compiler/Effect stack. `client` is supabase-js only. */
export function appTemplateFiles(
  name: string,
  template: "minimal" | "client",
  sdkDependencies: StarterSdkDependencies,
): Record<string, string> {
  switch (template) {
    case "client":
      return supabaseClientTemplate(name, sdkDependencies);
    case "minimal":
      return appFrameworkTemplate(name, sdkDependencies);
    default:
      return assertNeverTemplate(template);
  }
}
