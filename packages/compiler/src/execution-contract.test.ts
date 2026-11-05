import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeProject } from "./analyze";
import { compileProject } from "./compile";
import { renderApplication } from "./generate";
import { validateExecutionManifest } from "./execution-manifest";
import { renderDeliveryTarget } from "./delivery-render";
import { createDeliveryPlan } from "./delivery-plan";
import { createDependencyGraphCache } from "./incremental";
import { FIXTURE_TSCONFIG, RUNTIME_SOURCE } from "./fixtures/runtime-source";
import { writeFixtureProject } from "./fixtures/helpers";
import type { ApplicationGraph, CommandExecutionCapabilities } from "./types";

const declarations = `import { Command, Controller, Post, Module } from './runtime';
@Command({name: 'write', permission: 'items:write', transaction: 'required', audit: 'written', idempotency: 'required'})
export class Write { execute() { return 1; } }
@Module({name: 'root', providers: [Write]}) export class Root {}
`;

async function project(source: string, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "execution-contract-"));
  try {
    await writeFixtureProject(root, { "tsconfig.json": FIXTURE_TSCONFIG, "runtime.ts": RUNTIME_SOURCE, "app.ts": source });
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("raw command calls, aliases and extracted methods fail closed, including writeOnError", async () => {
  await project(declarations + `
function route(command: Write) { return command.execute(); }
function job(command: Write) { const alias = command; return alias['execute'](); }
function extraction(command: Write) { const { execute } = command; return execute(); }
function escape(command: Write) { return command.execute; }
@Command({name: 'arrow', permission: 'items:write'}) class Arrow { execute = () => 1; }
@Module({name: 'arrow', providers: [Arrow]}) class ArrowModule {}
function arrow(command: Arrow) { return command.execute(); }
`, async (rootDir) => {
    const result = await compileProject({ rootDir, outDir: join(rootDir, "generated"), writeOnError: true });
    const errors = result.diagnostics.filter((item) => item.code === "command-executor-bypass");
    expect(errors).toHaveLength(5);
    expect(errors.every((item) => item.errorCode === "SC4029" && item.file === "app.ts" && item.line)).toBe(true);
    expect(result.written).toEqual([]);
  });
});

test("bound routes allow only immediate same-command calls, not nested escaped continuations", async () => {
  await project(declarations + `
@Controller('/items') class Routes {
  constructor(private readonly command: Write) {}
  @Post('/ok', {command: Write}) ok() { return this.command.execute(); }
  @Post('/escape', {command: Write}) escape() { return () => this.command.execute(); }
}
@Module({name: 'http', providers: [Write], controllers: [Routes]}) class Http {}
`, async (root) => {
    const graph = await analyzeProject(root);
    expect(graph.diagnostics?.filter((item) => item.code === "command-executor-bypass")).toHaveLength(1);
  });
});

test("durable facades and literal executeCompiledCommand continuations preserve supported calls", async () => {
  await project(declarations + `
import { createTransactionalCommand as makeCommand } from '@supacloud/commands';
import { executeCompiledCommand as run } from '@supacloud/elysia';
@Command({name: 'durable', permission: 'items:write'}) class Durable {
  private readonly executor;
  constructor() { this.executor = makeCommand({}); }
  execute(input: unknown) { return this.executor.execute(input); }
  receipt(key: string) { return this.executor.lookupByReference(key); }
}
@Module({name: 'facades', providers: [Durable]}) class Facades {}
function safe(command: Durable) { return command.execute({}); }
function receipt(command: Durable) { return command.receipt('key'); }
function governed(command: Write) { return run({command: 'write', handler: () => command.execute()}); }
function wrong(command: Write) { return run({command: 'other', handler: () => command.execute()}); }
class Unrelated { execute() { return 0; } }
function ordinary(service: Unrelated) { return service.execute(); }
`, async (root) => {
    const graph = await analyzeProject(root);
    const errors = graph.diagnostics?.filter((item) => item.code === "command-executor-bypass") ?? [];
    expect(errors).toHaveLength(1);
    expect(errors[0]?.line).toBe(18);
  });
});

test("RPC-declared commands are governed at the database RPC, not at the call site", async () => {
  await project(declarations + `
@Command({name: 'rpc.write', permission: 'items:write', rpc: 'fa_write_item',
  transaction: 'required', audit: 'written', idempotency: 'required'})
export class RpcWrite { execute() { return 1; } }
@Module({name: 'rpc', providers: [RpcWrite]}) class RpcModule {}
class Service {
  constructor(private readonly command: RpcWrite) {}
  private async helper() { return this.command.execute(); }
  run() { return this.helper(); }
}
function extracted(command: RpcWrite) { return command.execute; }
`, async (root) => {
    const graph = await analyzeProject(root);
    const errors = graph.diagnostics?.filter((item) => item.code === "command-executor-bypass") ?? [];
    // The helper call is allowed: the RPC owns receipt, audit and transaction.
    // Extracting the method as a value still fails closed.
    expect(errors).toHaveLength(1);
  });
});

test("incremental analysis rejects new bypasses without stale diagnostics after repair", async () => {
  await project(declarations, async (root) => {
    const cache = createDependencyGraphCache();
    const bypasses = async () => (await analyzeProject(root, undefined, cache)).diagnostics
      ?.filter((item) => item.code === "command-executor-bypass");
    expect(await bypasses()).toEqual([]);
    await writeFixtureProject(root, { "app.ts": declarations + "function bypass(command: Write) { return command.execute(); }" });
    expect(await bypasses()).toHaveLength(1);
    await writeFixtureProject(root, { "app.ts": declarations });
    expect(await bypasses()).toEqual([]);
  });
});

const graph: ApplicationGraph = { externalTokens: [], modules: [{
  name: "root", className: "Root", file: "app.ts", line: 1, tags: ["type:root"],
  imports: [], exports: [], providers: [], controllers: [{
    className: "Health", path: "/health", scope: "application", deps: [], file: "app.ts", importPath: "app",
    routes: [{ method: "GET", path: "/", handler: "read" }],
  }], queries: [], commands: [{
    name: "write", className: "Write", permission: "items:write", audit: "written",
    transaction: "required", idempotency: "required", rpc: "database",
  }],
}] };
const capabilities: CommandExecutionCapabilities = {
  requirePersistentAdapters: true, permission: true,
  rpc: { database: { boundary: "database", audit: true, idempotency: true, transaction: true } },
};

test("execution manifests retain rules and branch requirements and fail on missing deployment capabilities", () => {
  const { executionPlan } = renderApplication(graph, { rootDir: "/app", outDir: "/app/generated", moduleBoundaryPreset: "modular-monolith" });
  expect(executionPlan.boundaries.length).toBeGreaterThan(0);
  expect(executionPlan.modules[0]?.commands[0]).toMatchObject({ permission: "items:write", audit: "written", adapter: "database" });
  expect(validateExecutionManifest(executionPlan, capabilities)).toEqual([]);
  expect(validateExecutionManifest(executionPlan).some((item) => item.code === "command-rpc-unavailable")).toBe(true);
  expect(validateExecutionManifest(executionPlan, { ...capabilities, permission: false }).some((item) => item.code === "command-permission-unsupported")).toBe(true);
  const command = executionPlan.modules[0]!.commands[0]!;
  command.adapter = null;
  command.branches = [{ when: "external", rpc: "remote", transaction: "none", audit: "sent", idempotency: "required" }];
  expect(validateExecutionManifest(executionPlan, capabilities).some((item) => item.code === "command-rpc-unavailable")).toBe(true);
  expect(validateExecutionManifest(executionPlan, { ...capabilities, rpc: {
    remote: { boundary: "external", audit: true, idempotency: true, reconcile: true },
  } })).toEqual([]);
});

test("delivery consumes the emitted plan and rejects missing declared adapters before writing bundles", () => {
  const planned = createDeliveryPlan(graph, { version: 1, targets: [{ name: "api", kind: "api", modules: ["root"] }] }, { commandCapabilities: capabilities });
  expect(planned.ok).toBe(true);
  if (!planned.ok) throw new Error(JSON.stringify(planned.diagnostics));
  const target = planned.plan.targets[0]!;
  expect(() => renderDeliveryTarget(graph, target, { rootDir: "/app", outDir: "/app/generated" })).toThrow("SC4014");
  const rendered = renderDeliveryTarget(graph, target, { rootDir: "/app", outDir: "/app/generated", commandCapabilities: capabilities });
  expect(rendered.executionPlan.modules[0]?.commands[0]?.adapter).toBe("database");
});

test("Feature handler boundaries and Effect metadata do not imply route-level governance", () => {
  const module = graph.modules[0]!;
  const controller = module.controllers[0]!;
  const effect = { required: true as const, dependencies: ["Repository"], retry: "none" as const };
  const featureGraph: ApplicationGraph = { ...graph, modules: [{
    ...module,
    controllers: [{ ...controller, routes: [{ method: "POST", path: "/", handler: "write", effect }] }],
    featureSpec: { name: "items", states: ["draft", "ready"], transitions: [{
      name: "write", from: "draft", to: "ready", command: "Write", route: "POST /health", routeBinding: "controller",
    }] },
  }] };
  const { executionPlan } = renderApplication(featureGraph, { rootDir: "/app", outDir: "/app/generated" });
  expect(executionPlan.modules[0]?.routes[0]).toMatchObject({
    command: "write", commandBoundary: "handler", executor: "route", stages: ["handler"], effect,
  });
  expect(executionPlan.modules[0]?.plugin.lifecycle).toEqual(["onError", "derive", "onAfterResponse"]);
});
