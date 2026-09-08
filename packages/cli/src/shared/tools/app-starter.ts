import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { STARTER_ENVIRONMENT, STARTER_ENVIRONMENT_TEST } from "./app-starter-environment";
import compilerMetadata from "../../../../compiler/package.json" with { type: "json" };
import appMetadata from "../../../../app/package.json" with { type: "json" };
import elysiaMetadata from "../../../../elysia/package.json" with { type: "json" };

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Embedded source strings are included in both the npm CLI and standalone binary. */
export function appStarterFiles(name: string): Record<string, string> {
    return {
        "package.json": json({
            name, version: "0.0.0", private: true, type: "module",
            engines: { bun: ">=1.4.0" },
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
                "@types/bun": "^1.4.0",
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
        ".gitignore": [
            "node_modules/", "dist/", ".env", ".env.*", "!.env.*.example", "!.env.test", "",
        ].join("\n"),
        ".env.development.example": "APP_ENV=development\nPORT=3000\n",
        ".env.test": "APP_ENV=test\n",
        ".env.staging.example": "APP_ENV=staging\n# Inject credentials using the deployment platform.\n",
        ".env.production.example": "APP_ENV=production\n# Inject credentials using the deployment platform.\n",
        "supacloud.config.ts": `import { defineSupacloudConfig } from "@supacloud/compiler";

export default defineSupacloudConfig({
  root: "src",
  outDir: "generated",
  strict: true,
  commandCapabilities: { permission: true, transaction: true, idempotency: true, audit: true },
});
`,
        "scripts/environment.ts": STARTER_ENVIRONMENT,
        "tests/environment.test.ts": STARTER_ENVIRONMENT_TEST,
        "scripts/dev.ts": `import { watchProject, compileOptionsFromConfig, loadSupacloudConfig } from "@supacloud/compiler";

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
`,
        "scripts/serve.ts": `import { createDemo } from "./sandbox";

if (process.env.APP_ENV !== "development") throw new Error("The demo server is development-only");
const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid PORT");
const sandbox = createDemo();
const server = Bun.serve({
  hostname: "127.0.0.1", port,
  fetch: (request) => sandbox.app.handle(request),
});
console.log("Local demo: " + server.url);
`,
        "scripts/sandbox.ts": `import { createMemorySandbox } from "@supacloud/elysia";
import { createCompiledModules } from "../generated/application";

export function createDemo() {
  if (process.env.APP_ENV !== "development" && process.env.APP_ENV !== "test") {
    throw new Error("Memory adapters are restricted to development and test");
  }
  const sandbox = createMemorySandbox({
    modules: createCompiledModules(),
    identity: { authenticated: true, subject: "local-demo" },
    memoryGovernance: true,
  });
  sandbox.policy.grant("local-demo", "review.approve");
  sandbox.db.set("reviews", "demo", { state: "draft", version: 1 });
  return sandbox;
}
`,
        "src/application.ts": `import { createApplication, createSupAuthRequestContext, type SupAuthContextOptions, type ApplicationOptions, type CommandGovernance } from "@supacloud/elysia";
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
`,
        "src/review/review.ts": `import {
  Body, Command, Controller, DB_CLIENT, Get, Inject, Param, Post,
  defineFeatureSlice, defineFeatureSpec, type Aspect,
} from "@supacloud/app";
import { ApplicationError, assertFeatureTransition } from "@supacloud/elysia";
import { t } from "elysia";

export const reviewSpec = defineFeatureSpec({
  name: "review",
  states: ["draft", "approved"],
  transitions: {
    approve: {
      from: "draft", to: "approved", command: "ApproveReview",
      permission: "review.approve", transaction: "required",
      idempotency: "required", audit: "review.approved",
      route: "POST /reviews/:id/approve",
    },
  },
});

interface Review { state: string; version: number }
// Production implementations must bind both operations to the current transaction.
export interface ReviewStore {
  get(table: string, key: string): unknown;
  set(table: string, key: string, value: Review): void;
}

export const Params = t.Object({ id: t.String({ minLength: 1 }) });
export const ApproveBody = t.Object({ expectedVersion: t.Integer({ minimum: 1 }) });
export const ReviewResult = t.Object({
  state: t.Union([t.Literal("draft"), t.Literal("approved")]),
  version: t.Integer({ minimum: 1 }),
});
export const HealthResult = t.Object({ ok: t.Boolean() });

// Explicit, statically compiled AOP. Do not log identity, request bodies or secrets.
export const requireRequest: Aspect = (context, next) => {
  if (!context.request) throw new ApplicationError("Request context required", { code: "REQUEST_REQUIRED" });
  return next();
};

function readReview(value: unknown): Review {
  if (typeof value !== "object" || value === null ||
      !("state" in value) || typeof value.state !== "string" ||
      !("version" in value) || typeof value.version !== "number") {
    throw new ApplicationError("Review not found", { status: 404, code: "REVIEW_NOT_FOUND" });
  }
  return { state: value.state, version: value.version };
}

@Command({
  name: "review.approve", permission: "review.approve", transaction: "required",
  idempotency: "required", audit: "review.approved", aspects: [requireRequest],
})
export class ApproveReview {
  constructor(@Inject(DB_CLIENT) private readonly store: ReviewStore) {}

  execute(id: string, expectedVersion: number): Review {
    const current = readReview(this.store.get("reviews", id));
    if (current.version !== expectedVersion) {
      throw new ApplicationError("Review state or version changed", { status: 409, code: "REVIEW_CONFLICT" });
    }
    const next = {
      state: assertFeatureTransition(reviewSpec, current.state, "approve"),
      version: current.version + 1,
    };
    this.store.set("reviews", id, next);
    return next;
  }
}

@Controller("/reviews")
export class ReviewController {
  constructor(@Inject(ApproveReview) private readonly approveReview: ApproveReview) {}

  @Get("/health", { response: HealthResult })
  health(): { ok: boolean } { return { ok: true }; }

  @Post("/:id/approve", { command: ApproveReview, params: Params, body: ApproveBody, response: ReviewResult })
  approve(@Param("id") id: string, @Body() body: { expectedVersion: number }): Review {
    return this.approveReview.execute(id, body.expectedVersion);
  }
}

export const ReviewFeature = defineFeatureSlice({
  name: "review", tags: ["type:feature"], spec: reviewSpec,
  providers: [ApproveReview], controllers: [ReviewController],
});
`,
        "tests/review.test.ts": `import { expect, test } from "bun:test";
import { createApp } from "../src/application";
import { createDemo } from "../scripts/sandbox";

function approve(sandbox: ReturnType<typeof createDemo>, key: string, expectedVersion = 1) {
  return sandbox.request("/reviews/demo/approve", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ expectedVersion }),
  });
}

test("health and successful transition with an idempotent replay", async () => {
  const sandbox = createDemo();
  expect((await sandbox.request("/reviews/health")).status).toBe(200);
  expect(await (await approve(sandbox, "once")).json()).toEqual({ state: "approved", version: 2 });
  expect(await (await approve(sandbox, "once")).json()).toEqual({ state: "approved", version: 2 });
  expect(sandbox.db.get("reviews", "demo")).toEqual({ state: "approved", version: 2 });
  expect(sandbox.audit).toEqual([{ command: "review.approve", outcome: "succeeded" }]);
});

test("permission denial, stale versions, invalid transitions and conflicting replays fail closed", async () => {
  const sandbox = createDemo();
  sandbox.policy.revoke("local-demo", "review.approve");
  expect((await approve(sandbox, "denied")).status).toBe(403);
  expect(sandbox.db.get("reviews", "demo")).toEqual({ state: "draft", version: 1 });
  sandbox.policy.grant("local-demo", "review.approve");
  expect((await approve(sandbox, "stale", 2)).status).toBe(409);
  expect(sandbox.db.get("reviews", "demo")).toEqual({ state: "draft", version: 1 });
  expect((await approve(sandbox, "success")).status).toBe(200);
  expect((await approve(sandbox, "invalid-transition", 2)).status).toBe(409);
  expect((await approve(sandbox, "success", 2)).status).toBe(409);
});

test("invalid input and a missing idempotency key never reach the handler", async () => {
  const sandbox = createDemo();
  expect((await approve(sandbox, "invalid", 0)).status).toBe(422);
  expect((await approve(sandbox, "")).status).toBe(400);
  expect(sandbox.db.get("reviews", "demo")).toEqual({ state: "draft", version: 1 });
});

test("transaction adapter rolls back mutations when work fails", async () => {
  const sandbox = createDemo();
  await expect(sandbox.db.transaction(() => {
    sandbox.db.set("reviews", "demo", { state: "approved", version: 2 });
    throw new Error("rollback");
  })).rejects.toThrow("rollback");
  expect(sandbox.db.get("reviews", "demo")).toEqual({ state: "draft", version: 1 });
});

test("the production composition root rejects missing governance adapters", async () => {
  const sandbox = createDemo();
  const app = createApp({
    deps: { dbClient: sandbox.db },
    requestContext: () => ({ identity: { authenticated: true, subject: "test" } }),
    commandGovernance: { authorize: () => {} },
  });
  const response = await app.handle(new Request("http://localhost/reviews/demo/approve", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "production" },
    body: JSON.stringify({ expectedVersion: 1 }),
  }));
  expect(response.status).toBe(501);
  expect(sandbox.db.get("reviews", "demo")).toEqual({ state: "draft", version: 1 });
});
`,
        "README.md": `# ${name}

## Local Development

\`\`\`sh
bun install
bun run check
bun run dev
\`\`\`

Bun 1.4+ is required. No SupaCloud account, token, PostgreSQL or S3 is needed
for this local demo. The server binds only to 127.0.0.1:3000. Set PORT in
.env.development.local to change it. Source changes trigger semantic compilation
and restart the server only after a successful compile. Demo data resets on restart.

\`\`\`sh
curl http://127.0.0.1:3000/reviews/health
curl -X POST http://127.0.0.1:3000/reviews/demo/approve \\
  -H 'Content-Type: application/json' -H 'Idempotency-Key: first-approval' \\
  -d '{"expectedVersion":1}'
\`\`\`

The included feature demonstrates a declared draft-to-approved transition,
compiler-checked command/route/governance bindings, an explicit AOP function,
HTTP schemas, permission denial, transaction rollback, idempotency and audit.
It is not a complete Maker-Checker workflow or a production authorization policy.

## Environments

Use .env.development.local for private developer values, .env.test for public
test fixtures, and platform-injected variables for staging/production.
.env.<target> is loaded first, then .env.<target>.local (development/staging only),
then process variables. Common .env, .env.local, dev.env, prod.env and parent
directories are never read. Test ignores .env.test.local; production rejects
.env.production.local. Values use Node parseEnv semantics, without dollar expansion.
Templates contain no credentials. Keep generated/ committed for drift checks.

\`\`\`sh
bun run env:staging bun run build
bun run env:production bun run build
\`\`\`

APP_ENV selects development/test/staging/production independently of optimization.
SUPACLOUD_ENV maps non-production targets to test and production to production.
Conflicting inherited environment selectors fail. Remote credentials must be
explicitly environment-tagged and complete; no target is inferred from a token.
The env wrappers do not deploy or verify credential ownership. Remote deployment
must also pin and validate the expected project and API origin.

## Production Boundary

\`bun run build\` creates dist/application.js, an application factory, not a
production server. The compiler is a devDependency and is absent from that
runtime entry. The memory demo is kept in scripts/ and refuses staging/production.

Import createApp from dist/application.js in your trusted host and supply:

- deps.dbClient implementing ReviewStore, with reads/writes bound to a real transaction;
- requestContext from verified identity, never a body-supplied actor;
- commandGovernance authorization, durable idempotency, transaction and audit adapters.

The demo store uses synchronous get/set. Replace it and ApproveReview with your
async database repository or a transactional RPC before production use. The
authoritative database must lock or compare row versions, enforce authorization,
and commit transition, idempotency receipt and audit atomically. For distributed
side effects use a transactional outbox. Client state machines are projections,
not a security boundary. Missing declared runtime adapters return an error.

## Unified User Center

For enterprise unified login, use SupAuth as the external user center. This
starter exports createSupAuthApp(identity, adapters) from dist/application.js.
Supply issuer, audience, clientId, projectId, an explicit HTTPS jwksUrl and resolveAccess
that reads current application-local access. The runtime verifies credential
signatures, configured issuer and audience, allowed asymmetric algorithms/keys
and expiry before constructing requestContext. The token must have the
authenticated user role and matching client_id/azp application binding.
Invalid credentials return 401; verification service failures return 503.
It does not create a user center.

Map the verified issuer and subject to application-local membership and
permissions. A unified user does not automatically have access to every project.
Never trust a body-supplied actor or an unverified decoded token. When identity
cannot be verified, deny protected access; never fall back to the demo identity,
local login or a service-role bypass. Do not duplicate passwords or token issuance
in business modules. Recheck business authorization on idempotent replay.

Local compilation and deterministic tests do not require SupAuth credentials.
Before production acceptance, test legitimate SupAuth sessions across two
applications, cross-project denial, invalid/expired credentials and permission
revocation. The local memory tests are not proof of these integration guarantees.

## Inspection And Repair

\`\`\`sh
bunx supacloud-compiler context review --root src --json
bunx supacloud-compiler explain review --root src
bunx supacloud-compiler check --json
bunx supacloud-compiler fix ./fix.json --dry-run
\`\`\`

Context packs include directional dependencies, relevant aspect files, diagnostics
and static execution plans. Share these rather than credentials or production
data. Fixes default to preview; use --write only after reviewing the selected
policy. Invalid transaction/idempotency modes fail compilation instead of
silently disabling governance. onExecution receives metadata-only trace events;
durable audit still belongs to the command governance adapter.

## CI

After the first compilation, commit generated/. In CI run
\`bun run check:generated\` before any command that regenerates files, then
\`bun run typecheck\` and \`bun run test\`. \`bun run check\` bootstraps a newly
initialized project. The compiler's strict mode checks metadata, type safety
and governance; TypeScript checks both application and generated source.
`,
    };
}

export async function initializeAppProject(options: { root?: string; name?: string }): Promise<{
    root: string; name: string; files: string[];
}> {
    const root = resolve(options.root ?? process.cwd());
    const name = options.name ?? basename(root);
    if (!/^[a-z][a-z0-9-]*$/.test(name) || name.length > 100) {
        throw new Error("Project name must be lowercase kebab-case (1-100 characters)");
    }
    await mkdir(root, { recursive: true });
    const stat = await lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Project root must be a real directory");
    if ((await readdir(root)).some((entry) => entry !== ".git")) {
        throw new Error("app init requires an empty directory (an existing .git directory is allowed)");
    }
    const files = appStarterFiles(name);
    for (const [relativePath, content] of Object.entries(files)) {
        const path = join(root, relativePath);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    }
    return { root, name, files: Object.keys(files) };
}
