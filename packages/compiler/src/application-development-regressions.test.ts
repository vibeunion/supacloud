import { expect, test } from "bun:test";
import { APPLICATION_DEVELOPMENT_LIMITS, createApplicationDevelopmentContext, formatApplicationDevelopmentContext } from "./application-development";
import type { ApplicationGraph, ModuleNode, ProviderNode } from "./types";

const provider = (token: string): ProviderNode => ({ token, tokenKind: "class", kind: "class", scope: "application", deps: [], exported: false, file: "src/m.ts", line: 1 });
const module = (name = "m"): ModuleNode => ({
  name, className: `${name}Module`, file: `src/${name}.ts`, line: 1, imports: [],
  providers: [], controllers: [], commands: [], queries: [], exports: [],
});
function graph(): ApplicationGraph {
  const m = module();
  m.commands = [{ className: "CreateOrder", name: "orders.create", transaction: "required", idempotency: "required" }];
  m.controllers = [{ className: "OrdersController", deps: [], scope: "application", file: "src/m.ts", importPath: "src/m", path: "/orders/", routes: [
    { method: "POST", path: "/", handler: "create", command: "CreateOrder" },
    { method: "GET", path: "/:id/", handler: "read" },
  ] }];
  return { modules: [m], externalTokens: [] };
}

test("development routes expose the same full path and canonical command as execution plans", () => {
  const context = createApplicationDevelopmentContext(graph());
  expect(context.routes.find(route => route.method === "POST")).toMatchObject({ path: "/orders", command: "orders.create" });
  expect(context.routes.find(route => route.method === "GET")?.path).toBe("/orders/:id");
  for (const route of context.routes) {
    const plan = context.executionPlans.find(plan => plan.kind === "route" && plan.name === `${route.method} ${route.path}`);
    expect(plan).toBeDefined();
    expect(plan?.command).toBe(route.command);
  }
});

test("resource use ordering and module inventories are stable under input permutation", () => {
  const first = graph();
  const m = first.modules[0]!;
  m.tags = ["z", "a"]; m.providers = [provider("Z"), provider("A")]; m.resources = ["z-db", "a-db"];
  first.resourceUses = [
    { module: "m", command: "orders.create", resource: "z-db", resourceClass: "Z", operations: ["write", "read"] },
    { module: "m", command: "orders.create", resource: "a-db", resourceClass: "A", operations: ["read"] },
  ];
  first.diagnostics = [{ code: "z", severity: "warn", message: "PRIVATE" }, { code: "a", severity: "error", message: "PRIVATE" }];
  const before = JSON.stringify(first);
  const second = structuredClone(first);
  const n = second.modules[0]!;
  n.tags!.reverse(); n.providers.reverse(); n.resources!.reverse(); n.controllers[0]!.routes.reverse();
  second.resourceUses!.reverse(); second.resourceUses!.forEach(use => use.operations.reverse()); second.diagnostics!.reverse();
  expect(createApplicationDevelopmentContext(first)).toEqual(createApplicationDevelopmentContext(second));
  expect(JSON.stringify(first)).toBe(before);
});

test("provider limit is document-wide and dropped modules' providers are counted", () => {
  const source: ApplicationGraph = { modules: [module("a"), module("b")], externalTokens: [] };
  for (const m of source.modules) m.providers = Array.from({ length: 80 }, (_, i) => provider(`${m.name}${i}`));
  const context = createApplicationDevelopmentContext(source);
  expect(context.modules.reduce((count, module) => count + module.providers.length, 0)).toBe(APPLICATION_DEVELOPMENT_LIMITS.providers);
  expect(context.omitted.providers).toBe(32);
  const many: ApplicationGraph = { modules: Array.from({ length: 65 }, (_, i) => ({ ...module(`m${i.toString().padStart(2, "0")}`), providers: [provider(`p${i}`)] })), externalTokens: [] };
  expect(createApplicationDevelopmentContext(many).omitted).toMatchObject({ modules: 1, providers: 1 });
});

test("text output reports omissions and does not imply deployment verification", () => {
  const source: ApplicationGraph = { modules: Array.from({ length: 65 }, (_, i) => module(`m${i}`)), externalTokens: [] };
  const text = formatApplicationDevelopmentContext(createApplicationDevelopmentContext(source));
  expect(text).toContain("modules=1");
  expect(text).toContain("current-graph");
  expect(text).toContain("deploymentVerified: false");
});

test("invalid diagnostic locations and unsafe paths are not projected", () => {
  const source = graph();
  source.modules[0]!.file = "C:\\private\\module.ts";
  source.diagnostics = [
    { code: "x", severity: "warn", line: -1, file: "../PRIVATE.ts", message: "PRIVATE" },
    { code: "y", severity: "error", line: 1.5, file: "https://private.test/file", message: "PRIVATE" },
  ];
  const context = createApplicationDevelopmentContext(source);
  expect(context.modules[0]!.file).toBeUndefined();
  for (const diagnostic of context.diagnostics) { expect(diagnostic.file).toBeUndefined(); expect(diagnostic.line).toBeUndefined(); }
  expect(JSON.stringify(context)).not.toContain("PRIVATE");
});
