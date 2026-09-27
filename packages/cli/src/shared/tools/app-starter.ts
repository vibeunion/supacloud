import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { STARTER_ENVIRONMENT, STARTER_ENVIRONMENT_TEST } from "./app-starter-environment";
import { appTemplateFiles, type StarterTemplate } from "./app-starter-templates";
import { STARTER_REVIEW_JOB, STARTER_REVIEW_JOB_TEST } from "./app-starter-review-job";
import { STARTER_ATTACHMENT_POSTGRES, STARTER_ATTACHMENT_SCHEMA } from "./app-starter-attachments";
import { STARTER_ATTACHMENT_WORKER, STARTER_ATTACHMENT_DELIVERY_WORKER } from "./app-starter-attachment-worker";
import { STARTER_UPLOAD_FEATURE, STARTER_UPLOAD_SCHEMA, STARTER_UPLOAD_ADAPTER } from "./app-starter-upload";
import { STARTER_RUNTIME_ROLES_SCHEMA } from "./app-starter-roles";
import { STARTER_REVIEW_DELIVERY_HOST, STARTER_REVIEW_POSTGRES, STARTER_REVIEW_POSTGRES_TEST, STARTER_REVIEW_SCHEMA } from "./app-starter-postgres";
import compilerMetadata from "../../../../compiler/package.json" with { type: "json" };
import appMetadata from "../../../../app/package.json" with { type: "json" };
import elysiaMetadata from "../../../../elysia/package.json" with { type: "json" };
import commandsMetadata from "../../../../commands/package.json" with { type: "json" };
import contractsMetadata from "../../../../contracts/package.json" with { type: "json" };
import dbMetadata from "../../../../db/package.json" with { type: "json" };
import sdkMetadata from "../../../../supacloud-js/package.json" with { type: "json" };

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Embedded source strings are included in both the npm CLI and standalone binary. */
export function appStarterFiles(name: string): Record<string, string> {
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
                "@supacloud/commands": `^${commandsMetadata.version}`,
                "@supacloud/contracts": `^${contractsMetadata.version}`,
                "@supacloud/db": `^${dbMetadata.version}`,
                "@supacloud/js": `^${sdkMetadata.version}`,
                "@supabase/supabase-js": sdkMetadata.peerDependencies["@supabase/supabase-js"],
                elysia: "2.0.0-beta.19",
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
  moduleBoundaryPreset: "modular-monolith",
  typeSafety: { scanProductionSource: true, noAnyInGenerated: true },
  disallowControllerDirectDb: true,
  detectOrphanModules: true,
  graphql: { schema: "graphql/schema.graphql" },
  commandCapabilities: { permission: true, transaction: true, idempotency: true, audit: true },
  delivery: {
    version: 1,
    build: {
      migrations: [
        { source: "migrations/001-review.sql", version: "1", name: "review", executor: "project-migration" },
        { source: "migrations/002-review-attachments.sql", version: "2", name: "review_attachments", executor: "project-migration" },
        { source: "migrations/003-review-uploads.sql", version: "3", name: "review_uploads", executor: "operator-provisioning" },
        { source: "migrations/004-review-runtime-roles.sql", version: "4", name: "review_runtime_roles", executor: "operator-provisioning" },
      ],
    },
  },
});
`,
        "graphql/schema.graphql": `# Offline query-contract example, not a deployed database schema.
# SYNTHETIC TEST FIXTURE ONLY. Database First is the sole server-schema model.
# Do not extend this fixture as a server schema; change database declarations and export.
# Replace using a snapshot exported with the intended caller role before integration.
type Query {
  reviewCollection(first: Int): ReviewConnection!
}
type ReviewConnection {
  edges: [ReviewEdge!]!
}
type ReviewEdge {
  node: Review!
}
type Review {
  id: ID!
  state: String!
  version: Int!
}
`,
        "src/review/reviews.graphql": `query ReviewList($first: Int = 20) {
  reviewCollection(first: $first) {
    edges { node { id state version } }
  }
}
`,
        "tests/graphql.test.ts": `import { expect, test } from "bun:test";
import { createGraphqlClient, type ReviewListQuery } from "../generated/graphql";

test("generated query client preserves its read contract without a live database", async () => {
  const data: ReviewListQuery = {
    reviewCollection: { edges: [{ node: { id: "demo", state: "draft", version: 1 } }] },
  };
  const queries = createGraphqlClient({
    url: "https://project.example.test",
    getAccessToken: async () => "synthetic-user-token",
    fetch: async (_url, request) => {
      expect(new Headers(request?.headers).get("Authorization")).toBe("Bearer synthetic-user-token");
      expect(JSON.parse(String(request?.body)).variables).toEqual({ first: 10 });
      return Response.json({ data });
    },
  });
  expect(await queries.ReviewList({ first: 10 })).toEqual(data);
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
        "generated/application.ts": `// BOOTSTRAP ARTIFACT: bun run compile replaces this file.
// Keeping a typed placeholder lets the first compile resolve the application entrypoint.
export function createCompiledModules(): never {
  throw new Error("Run bun run compile before starting the application");
}
`,
        "src/review/review.ts": `import {
  Body, Command, Controller, DB_CLIENT, Get, Inject, Param, Post,
  defineFeatureSlice, defineFeatureSpec, type Aspect,
} from "@supacloud/app";
import { ApplicationError, assertFeatureTransition } from "@supacloud/elysia";
import { t } from "elysia";
import { VerifyReviewAttachment } from "./attachment";
import { ReviewUploads, ReviewUploadsController, type ReviewUploadPort } from "./uploads";

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
export interface ReviewStore extends Partial<ReviewUploadPort> {
  get(table: string, key: string): unknown;
  set(table: string, key: string, value: Review): void | Promise<void>;
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

  async execute(id: string, expectedVersion: number): Promise<Review> {
    const current = readReview(await this.store.get("reviews", id));
    if (current.version !== expectedVersion) {
      throw new ApplicationError("Review state or version changed", { status: 409, code: "REVIEW_CONFLICT" });
    }
    const next = {
      state: assertFeatureTransition(reviewSpec, current.state, "approve"),
      version: current.version + 1,
    };
    await this.store.set("reviews", id, next);
    return next;
  }
}

@Controller("/reviews")
export class ReviewController {
  constructor(@Inject(ApproveReview) private readonly approveReview: ApproveReview) {}

  @Get("/health", { responses: { 200: HealthResult } })
  health(): { ok: boolean } { return { ok: true }; }

  @Post("/:id/approve", { command: ApproveReview, params: Params, body: ApproveBody, responses: { 200: ReviewResult } })
  approve(@Param("id") id: string, @Body() body: { expectedVersion: number }): Promise<Review> {
    return this.approveReview.execute(id, body.expectedVersion);
  }
}

export const ReviewFeature = defineFeatureSlice({
  name: "review", tags: ["type:feature"], spec: reviewSpec,
  providers: [ApproveReview, VerifyReviewAttachment, ReviewUploads], controllers: [ReviewController, ReviewUploadsController],
  jobs: [VerifyReviewAttachment],
});
`,
        "src/review/attachment.ts": STARTER_REVIEW_JOB,
        "src/review/uploads.ts": STARTER_UPLOAD_FEATURE,
        "src/host/review-uploads.ts": STARTER_UPLOAD_ADAPTER,
        "src/host/review-postgres.ts": STARTER_REVIEW_POSTGRES,
        "src/host/review-attachments.ts": STARTER_ATTACHMENT_POSTGRES,
        "src/host/review-attachment-worker.ts": STARTER_ATTACHMENT_WORKER,
        "src/delivery-worker.ts": STARTER_ATTACHMENT_DELIVERY_WORKER,
        "src/delivery-host.ts": STARTER_REVIEW_DELIVERY_HOST,
        "migrations/001-review.sql": STARTER_REVIEW_SCHEMA,
        "migrations/002-review-attachments.sql": STARTER_ATTACHMENT_SCHEMA,
        "migrations/003-review-uploads.sql": STARTER_UPLOAD_SCHEMA,
        "migrations/004-review-runtime-roles.sql": STARTER_RUNTIME_ROLES_SCHEMA,
        "tests/postgres-host.test.ts": STARTER_REVIEW_POSTGRES_TEST,
        "tests/attachment.test.ts": STARTER_REVIEW_JOB_TEST,
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

test("the production composition root rejects missing governance adapters", () => {
  const sandbox = createDemo();
  expect(() => createApp({
    deps: { dbClient: sandbox.db },
    requestContext: () => ({ identity: { authenticated: true, subject: "test" } }),
    commandGovernance: { authorize: () => {} },
  })).toThrow('Command "review.approve" has no audit adapter');
  expect(sandbox.db.get("reviews", "demo")).toEqual({ state: "draft", version: 1 });
  expect(sandbox.audit).toEqual([]);
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

## Typed Queries

This starter uses Database First as its only GraphQL server-schema model.
Drizzle and reviewed SQL define the database; pg_graphql reflects the migrated
database under the caller's role. Do not add GraphQL resolver/decorator classes
or independently authored server SDL. Business writes continue through Commands.

GraphQL is preconfigured as the recommended read path. Edit src/review/reviews.graphql;
compile, check and dev validate it against graphql/schema.graphql and generate
generated/graphql.ts. Import createGraphqlClient from that file and call
queries.ReviewList({ first: 20 }). Its variables and selected results are typed.
Pass a public project key and a getAccessToken callback that reads the current
user session. Never pass a service-role key to browser code.

The included schema is a synthetic offline test fixture, not a deployed database.
Do not hand-edit graphql/schema.graphql to add application fields. Change database
declarations, apply migrations and export the actual schema. Replace the fixture
with a snapshot exported under the intended caller role before real integration:

\`\`\`sh
bun node_modules/@supacloud/compiler/dist/cli.js graphql-schema \\
  --url https://your-project.example \\
  --key-env SUPACLOUD_PUBLISHABLE_KEY --token-env APP_USER_ACCESS_TOKEN
\`\`\`

After migrations or grants change, and before promotion, run the same command
with --check --json to detect drift without writing. If it fails, explicitly
re-export, review the snapshot diff, compile and run application typechecks and
role/RLS tests. Normal compile/check/dev remain offline; they cannot prove that
a snapshot came from a database or is current. Keep the exported snapshot and
generated types in version control.

The flags name environment variables, not credential values. Export requires
GraphQL and introspection already enabled on the selected development project.
The compiler does not enable extensions or alter database permissions.
Production introspection may remain disabled. Queries do not pass through
application Command/AOP; RLS and grants remain mandatory. Business writes stay
in Commands. Existing projects without GraphQL configuration remain unaffected.
Enabled contracts always reject invalid queries, including with strict: false.
To opt this starter out entirely, set graphql: false and remove its example
query test and unused generated client; do not replace checked queries with
untyped calls to bypass validation.

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

The starter also includes src/host/review-postgres.ts and src/delivery-host.ts.
The PostgreSQL adapter executes the same compiled approval handler with durable
receipts, audit, current membership/ownership checks on replay and transaction-bound
storage. It is specific to review.approve and rejects unconfigured commands.
Its database is dedicated to one project/tenant, checked against
public.starter_application at startup and during authorization.

The migration owner must apply the platform command-persistence schema and
migrations/001-review.sql, provision the project/tenant binding and current
memberships. After migrations 002-003, an administrator can apply
migrations/004-review-runtime-roles.sql to create the NOLOGIN, non-superuser,
non-BYPASSRLS roles starter_review_http and starter_review_worker. These names
are cluster-wide and reserved for this reference application; existing names
cause failure instead of silently adopting unknown privileges. Use a separate
application cluster or explicitly reviewed role naming for additional instances.
Provision separate unprivileged LOGIN accounts outside source control and grant
each exactly its matching runtime role, never the migration owner or service_role.
Keep public schema CREATE revoked from PUBLIC on the target database; verify
inherited grants and default privileges before activating the accounts.
The HTTP role can approve, bind attachments, append receipts/audits and start
Workflows. The Worker database role can read authorization records and insert
immutable results, but cannot approve, bind or start Workflows through SQL.
Row-lock column privileges have restrictive RLS checks preventing authority
record updates. Backend object authorization remains in the trusted adapters;
these roles do not establish per-request RLS identity. The Storage/Workflow
service key remains separately privileged and requires platform acceptance.
The local native-Lite detached hosts use separate restricted LOGIN accounts;
fixture setup and other test profiles still use the owned migration role.
This is not production-role acceptance. Ordinary API clients cannot edit membership
or the database binding. No migration, binding, member or review is auto-created
by the HTTP host. This SQL file is not a migration runner or a recovery receipt.

The starter's delivery.build.migrations explicitly declares these four files.
Immutable targets archive their exact bytes and a migrations.json inventory;
project migrations and operator provisioning use separate directories.
001-002 declare project migration handling. 003 changes Storage policies and
004 creates cluster-wide roles, so both declare operator provisioning; ordinary
project-role permission to perform those changes has not been established.
These raw SQL hashes are not the platform ledger's normalized-statement
checksums. Building or copying an archive never applies SQL, proves compatibility
or authorizes execution. Reconcile with the selected environment's canonical
ledger and use the existing platform migration flow for project migrations;
operator provisioning requires its separate administrator path.
Keep the platform Commands/Workflow prerequisites and their versions under
platform management. They are not silently copied into application migrations.

For an immutable executable HTTP build, configure delivery.build.httpApplications
with target "api" and source "delivery-host.ts". The declared attachment Job also
requires an explicitly selected runtime with process isolation and a durable
queue; configure delivery.runtime only after that target is selected. Then run
\`bun --no-env-file node_modules/@supacloud/compiler/dist/cli.js build\`.
Inject DATABASE_URL, APP_TENANT_ID, SUPACLOUD_PROJECT_ID, SUPAUTH_ISSUER,
SUPAUTH_AUDIENCE, SUPAUTH_CLIENT_ID and SUPAUTH_JWKS_URL at runtime.
Identity uses the configured remote JWKS verifier, never a synthetic local key.
PORT/HOST and shutdown are owned by the delivery runtime; the host closes its pool.
Do not include runtime secrets in the source tree or build inputs.

The Job output remains a factory unless a worker host is explicitly selected.
Without REVIEW_ATTACHMENTS=enabled this HTTP host delivers approval only and
authenticated upload requests return 501. With that setting, SUPACLOUD_URL and
SUPACLOUD_SERVICE_ROLE_KEY are required; shipped adapters register/bind uploads
and enqueue attachment verification through afterApproved in the approval
transaction. A separately delivered worker consumes it.
An HTTP listener or immutable build does not prove full-platform identity,
migration compatibility, activation, application rollback or data recovery.

The demo store uses synchronous get/set. ApproveReview awaits both operations,
so an async database repository can implement ReviewStore without replacing the
business handler. Bind that repository to the command's current transaction;
awaiting a write alone does not establish durability or atomicity.
The authoritative database must lock or compare row versions, enforce authorization,
and commit transition, idempotency receipt and audit atomically. For distributed
side effects use a transactional outbox. Client state machines are projections,
not a security boundary. Missing declared runtime adapters reject application
startup before any request is served.

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

## Approval Attachments

src/review/attachment.ts declares review.verify-attachment. Its input contains
only review ID, approved revision and immutable artifact ID, never a signed URL
or a user token. The compiled Job checks the uploaded bytes against the registered
digest and awaits a durable result. It does not create a queue, upload objects,
grant access or implement its own retry engine.

The trusted host must upload through private Storage, validate current ownership,
register an immutable Artifact and bind it to the review. Commit approval and
Workflow submission in the same database transaction. A separate worker claims
the existing Workflow and invokes the compiled Job with a ReviewAttachmentStore.
Its reader authorizes the worker independently; its writer rechecks the review
revision/artifact binding and persists the result idempotently before acknowledgement.
After a lost acknowledgement, reconcile that result instead of repeating effects.

src/host/review-attachments.ts supplies createReviewAttachmentAdapters with a
durable store and enqueue callback for the approval adapter's afterApproved hook.
Apply migrations/002-review-attachments.sql with the migration owner; no process
automatically provisions attachment tables or grants backend permissions.
Provision the Artifact/Storage service client and database for the same project.
The adapter checks the database project/tenant, current approval permission,
ownership and revision, exact registered object path, type and size. It rejects
conflicting durable results instead of treating any previous result as success.
The service endpoint's project binding remains the host operator's responsibility.
Apply migrations/003-review-uploads.sql and explicitly provision each member's
storage_subject using the platform's verified external-identity mapping.
The migration creates a private 1 MiB text/plain bucket, member/review read
policies and Storage INSERT/SELECT policies. Restrictive ownership and
UPDATE/DELETE fences prevent ordinary authenticated users from changing bytes
before Artifact registration even if broader permissive Storage policies exist.
These fences are bucket-scoped and do not grant access to other buckets.
Service-role provisioning, identity mapping and backend privileges still require
platform-specific review; the server service key must never reach callers.

POST /reviews/:id/attachment-upload accepts artifactId (a client-generated UUID)
and expectedVersion, and returns the identity-derived private bucket/path.
Upload there using the caller's authenticated Storage client, never a service
key or upsert. POST /reviews/:id/attachment-registration with the same body
computes the digest on the server, registers the immutable Artifact, then binds
it through a durable review.attach transaction with audit. These routes belong
to the compiled ApplicationGraph; they are not hidden host fetch handlers.
Registration is explicitly two-phase, not a distributed transaction: a failed
binding can leave an immutable orphan. Retry the same artifactId/body; do not
delete immutable evidence after an uncertain result. Current ownership,
membership, permission, project/tenant and revision are rechecked before binding
and on replay. The same binding can replay after its corresponding approval;
new uploads cannot be prepared once the review is approved.

src/delivery-worker.ts supplies a separate executable worker host. Bind it with
delivery.build.workerApplications: [{ target: "jobs", source: "delivery-worker.ts" }].
It uses the existing Workflow SDK and the compiled attachment Job, not a second
retry engine. Inject SUPACLOUD_URL, SUPACLOUD_SERVICE_ROLE_KEY,
SUPACLOUD_PROJECT_ID, APP_TENANT_ID, REVIEW_WORKER_ID and DATABASE_URL.
Alternatively use DATABASE_SOCKET_PATH with DATABASE_NAME and DATABASE_USER,
but never alongside DATABASE_URL. Secrets belong only in runtime configuration.
REVIEW_QUEUE_OWNERSHIP must be exclusive-review-attachments: the Workflow claim
API is shared and unfiltered, so this worker cannot safely share it with other
workflow types. Unknown workflows, versions, steps, unbound run IDs and uncertain
claim/settlement receipts latch a fatal failure and stop new claims. Unknown
claims remain unsettled for operator recovery, not automatically failed.
Ordinary Job failures use canonical Workflow retry/fail; completion follows the
committed idempotent result. The host's failure promise makes the executable exit
nonzero with bounded cleanup. Restart only after investigating an ownership or
receipt failure; repeated automatic restart can exhaust an unknown run's attempts.

The memory demo does not start this worker. The included unit tests exercise the
handler contract, not production Storage, queue delivery or external identity.

## Inspection And Repair

\`\`\`sh
bunx supacloud-compiler context review --root src --json
bunx supacloud-compiler context review --root src --events execution-events.json --request-id request-123 --json
bunx supacloud-compiler explain review --root src
bunx supacloud-compiler check --json
bunx supacloud-compiler fix ./fix.json --dry-run
\`\`\`

Context packs include directional dependencies, relevant aspect files, diagnostics
and static execution plans. Ordinary context can include declared source expressions;
inspect it before sharing. The optional --events example expects a trusted host
to capture approved onExecution metadata in { "version": 1, "events": [...] }.
It selects one opaque request ID, omits payloads and source expressions, and applies
input/output size limits. It does not read arbitrary logs, prove deployment versions,
identify a root cause or apply repairs. Never put credentials or business data in
request IDs. Fixes default to preview; use --write only after reviewing the selected
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

export async function initializeAppProject(options: { root?: string; name?: string; template?: StarterTemplate }): Promise<{
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
    const template = options.template ?? "command";
    const files = template === "command" ? appStarterFiles(name) : appTemplateFiles(name, template);
    for (const [relativePath, content] of Object.entries(files)) {
        const path = join(root, relativePath);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    }
    return { root, name, files: Object.keys(files) };
}
