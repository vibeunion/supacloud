import { afterEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "@supacloud/db/typescript";
import { initializeAppProject } from "./app-starter";
import { COMMAND_RECEIPT_SQL } from "./command-receipts";
import { compileProject, renderApplication, type ApplicationGraph } from "@supacloud/compiler";
import { COMMAND_RECEIPT_SQL as DATABASE_COMMAND_RECEIPT_SQL } from "@supacloud/db";
import { compileModel } from "@supacloud/db/model";
import { databaseSources } from "@supacloud/db/source-contracts";

const repo = resolve(import.meta.dir, "../../../../..");
type AspectContext = { readonly kind: "command" | "route"; readonly name: string; readonly input: unknown };
type MaybePromise<T> = T | Promise<T>;
type Aspect = (context: AspectContext, next: () => MaybePromise<unknown>) => MaybePromise<unknown>;
interface AspectDefinition {
  kind: "command";
  name: string;
  input: (value: unknown) => unknown;
  result: (value: unknown) => unknown;
  capabilities: (context: { services?: Record<string, unknown> }) => Record<string, unknown>;
}
interface AppExecution {
  composeAspects(aspect: Aspect): Aspect;
  defineOperationAspect(
    definition: AspectDefinition,
    handler: (context: { capabilities: Record<string, unknown>; input: { version: number } }, next: () => MaybePromise<unknown>) => MaybePromise<unknown>,
  ): Aspect;
}
interface ElysiaRuntime {
  createApplication(options: { modules: CompiledModule[]; commandExecutor: (invocation: unknown, next: () => MaybePromise<unknown>) => MaybePromise<unknown> }): { handle(request: Request): Promise<Response> };
}
interface CompiledRoute {
  method: "POST";
  path: string;
  handler: string;
  command: string;
  invoker: () => unknown;
  aspects: Aspect[];
}
interface CompiledModule {
  name: string;
  createServices(): Record<string, unknown>;
  controllers: Array<{ path: string; serviceKey: string; scope: "application"; routes: CompiledRoute[] }>;
  commands: Array<{ className: string; name: string; permission: string; transaction: "required" }>;
  registerRoutes(register: (controller: CompiledModule["controllers"][number], route: CompiledRoute, prefix: string) => void): void;
}
async function appExecution(): Promise<AppExecution> {
  // The focused starter gate builds these packages first; other workspaces only
  // typecheck or skip this test, so keep the build products out of the static graph.
  return await import(pathToFileURL(join(repo, "packages/app/dist/execution.js")).href) as AppExecution;
}
async function elysiaRuntime(): Promise<ElysiaRuntime> {
  return await import(pathToFileURL(join(repo, "packages/elysia/dist/index.js")).href) as ElysiaRuntime;
}
interface StarterPostgres {
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  withConnection<T>(run: (url: string) => Promise<T>): Promise<T>;
}
async function startStarterPostgres(bin: string): Promise<StarterPostgres> {
  // Keep repository-only test infrastructure out of the CLI declaration graph.
  const helper: { startStarterPostgres(bin: string): Promise<StarterPostgres> } = await import(
    pathToFileURL(join(repo, "scripts/lib/starter-postgres.ts")).href);
  return helper.startStarterPostgres(bin);
}
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "model-command-")); roots.push(root); return root;
}
async function dependencies(root: string) {
  const modules = join(root, "node_modules");
  await mkdir(join(modules, "@supacloud"), { recursive: true });
  for (const name of ["app", "commands", "contracts", "db", "compiler", "elysia"]) {
    await symlink(join(repo, "packages", name), join(modules, "@supacloud", name));
  }
  for (const name of ["typebox", "effect", "elysia", "typescript", "@types"]) {
    await symlink(join(repo, "packages/cli/node_modules", name), join(modules, name));
  }
  await symlink(join(repo, "packages/db/node_modules/@zenstackhq"), join(modules, "@zenstackhq"));
}

async function typecheck(root: string, extra: string[] = []) {
  const config = await ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = await ts.parseJsonConfigFileContent(config.config, ts.sys, root, {}, join(root, "tsconfig.json"));
  await using program = await ts.createProgram([...parsed.fileNames, ...extra], { ...parsed.options, noEmit: true }, { cwd: root });
  return [...parsed.errors, ...await ts.getPreEmitDiagnostics(program)].map(item =>
    `${item.file?.fileName ?? "config"}: ${ts.flattenDiagnosticMessageText(item.messageText, "\n")}`);
}

test("starter receipt schema stays byte-identical to the database package", () => {
  expect(COMMAND_RECEIPT_SQL).toBe(DATABASE_COMMAND_RECEIPT_SQL);
});

test("portable and generated command aspects preserve results, failures and continuation lifetime", async () => {
  const root = await temporary();
  const source = `
export let captured: (() => unknown) | undefined;
export async function boundary(context: { input: unknown }, next: () => Promise<unknown>): Promise<unknown> {
  if (context.input === "skip") return { fake: true };
  if (context.input === "swallow") { try { return await next(); } catch { return { fake: true }; } }
  if (context.input === "detach") { void next(); return { fake: true }; }
  const result = await next();
  if (context.input === "replace") return { fake: true };
  if (context.input === "twice") { try { await next(); } catch {} }
  if (context.input === "mutate" && result && typeof result === "object" && "nested" in result) {
    const nested = result.nested;
    if (nested && typeof nested === "object") Reflect.set(nested, "value", 2);
  }
  captured = next;
  return result;
}
`;
  await writeFile(join(root, "source.ts"), source);
  const graph: ApplicationGraph = { externalTokens: [], modules: [{
    name: "model", className: "Model", file: "source.ts", line: 1,
    imports: [], exports: [], providers: [], controllers: [], commands: [], queries: [],
    aspects: [{ name: "boundary", expression: "boundary", importPath: "source" }],
  }] };
  const generated = renderApplication(graph, { rootDir: root, outDir: join(root, "generated") }).applicationCode;
  await mkdir(join(root, "generated"));
  await writeFile(join(root, "generated/application.ts"), generated);
  const loaded: { boundary: Aspect; captured?: () => unknown } = await import(pathToFileURL(join(root, "source.ts")).href);
  const compiled: { createCompiledModules(): Array<{ aspectPipeline: Aspect }> } = await import(pathToFileURL(join(root, "generated/application.ts")).href);
  const { composeAspects } = await appExecution();
  for (const pipeline of [composeAspects(loaded.boundary), compiled.createCompiledModules()[0]!.aspectPipeline]) {
    const context = (input: string) => ({ kind: "command" as const, name: "test", input });
    let calls = 0;
    await expect(pipeline(context("skip"), () => { calls++; return {}; })).rejects.toMatchObject({ code: "ASPECT_CONTINUATION_REQUIRED" });
    expect(calls).toBe(0);
    await expect(pipeline(context("replace"), () => ({}))).rejects.toMatchObject({ code: "ASPECT_RESULT_REPLACED" });
    const failure = new Error("actual failure");
    await expect(pipeline(context("swallow"), () => { throw failure; })).rejects.toBe(failure);
    await expect(pipeline(context("twice"), () => ({}))).rejects.toMatchObject({ code: "ASPECT_CONTINUATION_REUSED" });
    const value = { nested: { value: 1 } };
    expect(await pipeline(context("mutate"), () => value)).toBe(value);
    expect(value.nested.value).toBe(1);
    expect(Object.isFrozen(value.nested)).toBe(true);
    expect(loaded.captured).toBeDefined();
    await expect(Promise.resolve().then(() => loaded.captured!())).rejects.toMatchObject({ code: "ASPECT_CONTINUATION_CLOSED" });
    let release: (() => void) | undefined;
    let finished = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = Promise.resolve(pipeline(context("detach"), async () => { await gate; finished = true; return {}; }));
    void pending.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 0)); expect(finished).toBe(false);
    release!(); await expect(pending).rejects.toMatchObject({ code: "ASPECT_CONTINUATION_UNAWAITED" }); expect(finished).toBe(true);
    const outcomes = await Promise.all([1, 2].map(id => pipeline(context("ok"), async () => ({ id }))));
    expect(outcomes).toEqual([{ id: 1 }, { id: 2 }]);
  }
});

test("typed aspects validate the operation and expose only explicit immutable data and capabilities", async () => {
  const { defineOperationAspect } = await appExecution();
  const decodeInput = (value: unknown): { version: number } => {
    if (!value || typeof value !== "object" || !("version" in value) || typeof value.version !== "number") throw new TypeError("input");
    return value as { version: number };
  };
  const aspect = defineOperationAspect({ kind: "command", name: "orders.approve", input: decodeInput, result: decodeInput,
    capabilities: () => ({ allowed: true }),
  }, async (context, next) => {
    expect(Object.keys(context).sort()).toEqual(["capabilities", "input", "kind", "name"]);
    expect(context.capabilities.allowed).toBe(true);
    return next();
  });
  const context = { kind: "command" as const, name: "orders.approve", input: { version: 1 } };
  const result = { version: 2 };
  expect(await aspect(context, () => result)).toBe(result);
  await expect(aspect({ ...context, name: "wrong" }, () => result)).rejects.toMatchObject({ code: "ASPECT_OPERATION_MISMATCH" });
  await expect(aspect({ ...context, input: {} }, () => result)).rejects.toThrow("input");
  await expect(aspect(context, () => "bad result")).rejects.toThrow("input");
});

test("HTTP route aspects cannot fabricate command success inside the transaction boundary", async () => {
  const { createApplication } = await elysiaRuntime();
  for (const mode of ["skip", "replace", "swallow", "ok"] as const) {
    let calls = 0, commits = 0, rollbacks = 0;
    const module: CompiledModule = {
      name: "guarded", createServices: () => ({}),
      controllers: [{ path: "/", serviceKey: "handler", scope: "application", routes: [{
        method: "POST", path: "/", handler: "execute", command: "guarded.execute",
        invoker: () => { calls++; if (mode === "swallow") throw new Error("actual failure"); return { ok: true }; },
        aspects: [async (context, next) => {
          expect(context.kind).toBe("route");
          if (mode === "skip") return { fake: true };
          try { const result = await next(); return mode === "replace" ? { fake: true } : result; }
          catch (error) { if (mode === "swallow") return { fake: true }; throw error; }
        }],
      }] }],
      commands: [{ className: "Guarded", name: "guarded.execute", permission: "execute", transaction: "required" }],
      registerRoutes(register) { register(this.controllers[0]!, this.controllers[0]!.routes[0]!, "/"); },
    };
    const app = createApplication({ modules: [module], commandExecutor: async (_invocation, next) => {
      try { const result = await next(); commits++; return result; }
      catch (error) { rollbacks++; throw error; }
    } });
    const response = await app.handle(new Request("http://localhost/", { method: "POST" }));
    expect(response.status).toBe(mode === "ok" ? 200 : 500);
    expect(calls).toBe(mode === "skip" ? 0 : 1);
    expect(commits).toBe(mode === "ok" ? 1 : 0);
    expect(rollbacks).toBe(mode === "ok" ? 0 : 1);
  }
});

test("model-command generates a strictly typed and governed application for HTTP and workers", async () => {
  const root = await temporary();
  await initializeAppProject({ root, name: "orders", template: "model-command" });
  await dependencies(root);
  await compileModel(join(root, "zenstack/schema.zmodel"), join(root, "zenstack/generated"));
  const sources = await databaseSources(root, "generate");
  expect(sources.findings).toEqual([]);
  const compiled = await compileProject({
    rootDir: join(root, "src"), outDir: join(root, "generated"), strict: true, writeOnError: false,
    databaseGovernance: { mode: "check", projectRoot: root, moduleFile: "db/modules.ts" },
    commandCapabilities: { requirePersistentAdapters: true, permission: true, transaction: true, audit: true, idempotency: true,
      rpc: { modelOrders: { boundary: "database", transaction: true, audit: true, idempotency: true } } },
  });
  expect(compiled.diagnostics.filter(item => item.severity === "error")).toEqual([]);
  const assertions = join(root, "aspect-types.ts");
  await writeFile(assertions, `import { defineOperationAspect } from "@supacloud/app/core";
const validate = (input: unknown): { version: number } => {
  if (!input || typeof input !== "object" || !("version" in input) || typeof input.version !== "number") throw new TypeError();
  return input as { version: number };
};
defineOperationAspect({ kind: "command", name: "typed", input: validate, result: validate, capabilities: () => ({ allowed: true }) }, async (context, next) => {
  // @ts-expect-error No implicit raw database capability.
  context.capabilities.db.query("SELECT 1");
  // @ts-expect-error No open service bag in the typed callback.
  context.services;
  // @ts-expect-error Operation input is immutable.
  context.input.version = 4;
  const result = await next();
  // @ts-expect-error Continuation results are immutable.
  result.version = 5;
  return result;
});
`);
  expect(await typecheck(root, [assertions])).toEqual([]);
  expect((await databaseSources(root)).ok).toBe(true);
}, 120_000);

interface Principal { id: string; tenantId: string; canCreate: boolean; canApprove: boolean }
interface Claim { actor: { id: string; tenantId: string }; operationId: string; input: { id: string; expectedVersion: number } }
interface IdentityAuthority {
  verifyHttp(request: Request): Promise<{ id: string; tenantId: string }>;
  verifyWorker(value: unknown): Promise<Claim>;
  resolve(actor: { id: string; tenantId: string }): Promise<Principal | null>;
}
interface ModelHost {
  app: { handle(request: Request): Promise<Response> };
  worker(claim: unknown, signal?: AbortSignal): Promise<unknown>;
  dispose(): Promise<void>;
}
interface HostModule { createModelOrderHost(pool: SQL, authority: IdentityAuthority): Promise<ModelHost> }
function isHostModule(value: unknown): value is HostModule {
  return !!value && typeof value === "object" && "createModelOrderHost" in value && typeof value.createModelOrderHost === "function";
}
const postgres = process.env["SUPACLOUD_STARTER_POSTGRES_BIN"];
test.skipIf(!postgres)("real model HTTP/worker flow isolates tenants, replays receipts, rejects revocation and rolls back failed audit", async () => {
  const root = await temporary();
  await initializeAppProject({ root, name: "orders", template: "model-command" });
  await dependencies(root);
  await compileModel(join(root, "zenstack/schema.zmodel"), join(root, "zenstack/generated"));
  await databaseSources(root, "generate");
  const compiled = await compileProject({ rootDir: join(root, "src"), outDir: join(root, "generated"),
    commandCapabilities: { requirePersistentAdapters: true, permission: true, transaction: true, audit: true, idempotency: true,
      rpc: { modelOrders: { boundary: "database", transaction: true, audit: true, idempotency: true } } } });
  expect(compiled.diagnostics.filter(item => item.severity === "error")).toEqual([]);
  const loaded: unknown = await import(pathToFileURL(join(root, "src/application.ts")).href);
  if (!isHostModule(loaded)) throw new Error("Missing model host");
  const server = await startStarterPostgres(postgres!);
  try {
    await server.exec(await readFile(join(root, "migrations/001-command-receipts.sql"), "utf8"));
    await server.exec(await readFile(join(root, "migrations/002-model-orders.sql"), "utf8"));
    await server.withConnection(async connection => {
      const governance = new SQL(connection, { max: 1 });
      try { await governance.unsafe(await readFile(join(root, "tests/database-governance.sql"), "utf8")); }
      finally { await governance.close(); }
    });
    const password = crypto.randomUUID();
    await server.exec(`ALTER ROLE model_orders_app LOGIN PASSWORD '${password}'`);
    await server.withConnection(async connection => {
      const runtime = new URL(connection); runtime.username = "model_orders_app"; runtime.password = password;
      const pool = new SQL(runtime.href, { max: 4 });
      let allowed = true;
      const principals: Record<string, Principal> = {
        alice: { id: "alice", tenantId: "a", canCreate: true, canApprove: false },
        reviewer: { id: "reviewer", tenantId: "a", canCreate: true, canApprove: true },
        other: { id: "alice", tenantId: "b", canCreate: true, canApprove: true },
      };
      const claims = new Map<string, Claim>();
      const authority: IdentityAuthority = {
        verifyHttp: async request => {
          const key = request.headers.get("authorization") ?? "";
          const principal = principals[key]; if (!principal) throw new Error("Unverified token");
          return { id: principal.id, tenantId: principal.tenantId };
        },
        verifyWorker: async value => {
          const claim = typeof value === "string" ? claims.get(value) : undefined;
          if (!claim) throw new Error("Unverified claim"); return claim;
        },
        resolve: async actor => {
          const principal = Object.values(principals).find(item => item.id === actor.id && item.tenantId === actor.tenantId);
          return principal && (principal.id !== "reviewer" || allowed) ? principal : null;
        },
      };
      const admin = new SQL(connection, { max: 1 });
      try { await expect(loaded.createModelOrderHost(admin, authority)).rejects.toThrow("non-owner application login"); }
      finally { await admin.close(); }
      await server.exec("GRANT starter_test TO model_orders_app");
      try { await expect(loaded.createModelOrderHost(pool, authority)).rejects.toThrow("non-owner application login"); }
      finally { await server.exec("REVOKE starter_test FROM model_orders_app"); }
      const host = await loaded.createModelOrderHost(pool, authority);
      const call = async (actor: string, path: string, key?: string, body?: object) => {
        const response = await host.app.handle(new Request("http://localhost" + path, {
          method: body ? "POST" : "GET", headers: { authorization: actor, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }));
        const result: unknown = await response.json();
        return { status: response.status, body: result };
      };
      try {
        expect(await call("alice", "/orders", "create-1", { id: "one", title: "First" })).toMatchObject({ status: 200, body: { status: "confirmed", audit: "complete", result: { outcome: "applied", order: { state: "draft", version: 1 } } } });
        expect(await call("other", "/orders/one")).toEqual({ status: 200, body: { order: null } });
        expect(await call("alice", "/orders/one/approve", "denied", { expectedVersion: 1 })).toMatchObject({ status: 403 });
        const approval = await call("reviewer", "/orders/one/approve", "approve-1", { expectedVersion: 1 });
        expect(approval).toMatchObject({ status: 200, body: { status: "confirmed", audit: "complete", result: { outcome: "applied", order: { state: "approved", version: 2 } } } });
        claims.set("signed-claim", { actor: principals.reviewer!, operationId: "approve-1", input: { id: "one", expectedVersion: 1 } });
        expect(await host.worker("signed-claim")).toEqual(approval.body);
        expect(await call("reviewer", "/orders/one/approve", "approve-1", { expectedVersion: 2 })).toMatchObject({ status: 409 });
        expect(await call("reviewer", "/orders/one/approve", "stale", { expectedVersion: 1 })).toMatchObject({ status: 200, body: { result: { outcome: "conflict", order: null } } });
        await expect(host.worker({ ...claims.get("signed-claim") })).rejects.toThrow("Unverified claim");
        allowed = false;
        await expect(host.worker("signed-claim")).rejects.toMatchObject({ code: "COMMAND_REJECTED" });
        expect(await call("reviewer", "/orders/one/approve", "approve-1", { expectedVersion: 1 })).toMatchObject({ status: 403 });
        allowed = true;
        expect(await call("alice", "/orders", "create-2", { id: "two", title: "Second" })).toMatchObject({ status: 200 });
        await server.exec(`CREATE FUNCTION public.fail_test_audit() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN
          IF NEW.operation_key = 'failed-audit' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $body$;
          CREATE TRIGGER fail_test_audit BEFORE INSERT ON supacloud_commands.execution_audit FOR EACH ROW EXECUTE FUNCTION public.fail_test_audit();`);
        expect(await call("reviewer", "/orders/two/approve", "failed-audit", { expectedVersion: 1 })).toMatchObject({ status: 503 });
        expect(await call("alice", "/orders/two")).toMatchObject({ body: { order: { state: "draft", version: 1 } } });
        expect(await pool`SELECT operation_key FROM supacloud_commands.execution_receipts WHERE operation_key='failed-audit'`).toHaveLength(0);
        expect(await pool`SELECT operation_key FROM supacloud_commands.execution_audit WHERE operation_key='failed-audit'`).toHaveLength(0);
        expect(await pool`SELECT operation_key FROM supacloud_commands.execution_audit WHERE operation_key='approve-1'`).toHaveLength(1);
        claims.set("worker-first", { actor: principals.reviewer!, operationId: "worker-first", input: { id: "two", expectedVersion: 1 } });
        const fromWorker = await host.worker("worker-first");
        expect(fromWorker).toMatchObject({ status: "confirmed", result: { order: { state: "approved", version: 2 } } });
        expect((await call("reviewer", "/orders/two/approve", "worker-first", { expectedVersion: 1 })).body).toEqual(fromWorker);
      } finally { await host.dispose(); await pool.close(); }
    });
  } finally { await server.close(); }
}, 120_000);
