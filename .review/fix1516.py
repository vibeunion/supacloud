from pathlib import Path
import subprocess
p=Path('packages/compiler/src/application-development.ts')
assert subprocess.check_output(['git','hash-object',str(p)],text=True).strip() == 'ba39dddffb869594da11f677234395b1f4e22822'
s=p.read_text().replace('import type { Diagnostic } from "./types";\n','')
s=s.replace('import { executionSourceFile } from "./execution-snapshot";', 'import { executionSourceFile } from "./execution-snapshot";\nimport { joinRoutePaths } from "./util";')
s=s.replace('  const entries = Object.entries(route.schemaKinds)\n', '  const entries = Object.entries(route.schemaKinds)\n    .filter(([key]) => ["body", "params", "query", "headers", "cookie", "response"].includes(key))\n')
s=s.replace('  return entries.length > 0 ? Object.fromEntries(entries) : undefined;', '  return entries.length > 0 ? Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right, "en"))) : undefined;')
s=s.replace('  const resourceUses = [...(graph.resourceUses ?? [])];', '''  const names = (values: readonly string[]) => [...values].sort((left, right) => left.localeCompare(right, "en"));
  const operationOrder = ["read", "write", "publish", "consume"];
  const resourceUses = (graph.resourceUses ?? []).map(use => ({ ...use,
    operations: [...use.operations].sort((left, right) => operationOrder.indexOf(left) - operationOrder.indexOf(right)),
  })).sort((left, right) =>
    left.module.localeCompare(right.module, "en")
    || Number(left.command === undefined) - Number(right.command === undefined)
    || (left.command ?? left.job ?? "").localeCompare(right.command ?? right.job ?? "", "en")
    || left.resource.localeCompare(right.resource, "en")
    || JSON.stringify(left.operations).localeCompare(JSON.stringify(right.operations), "en"));''')
s=s.replace('  let omittedProviders = 0;', '  let omittedProviders = 0;\n  let remainingProviders = APPLICATION_DEVELOPMENT_LIMITS.providers;')
s=s.replace('  for (const module of modules) {\n    const providers = bound(module.providers.map((provider) => provider.token), APPLICATION_DEVELOPMENT_LIMITS.providers);', '''  for (const [moduleIndex, module] of modules.entries()) {
    const providers = bound(names(module.providers.map((provider) => provider.token)),
      moduleIndex < APPLICATION_DEVELOPMENT_LIMITS.modules ? remainingProviders : 0);
    remainingProviders -= providers.items.length;''')
s=s.replace('{ tags: [...module.tags] }', '{ tags: names(module.tags) }')
s=s.replace('controllers: module.controllers.map((controller) => controller.className),', 'controllers: names(module.controllers.map((controller) => controller.className)),')
s=s.replace('commands: module.commands.map((command) => command.name),', 'commands: names(module.commands.map((command) => command.name)),')
s=s.replace('jobs: (module.jobs ?? []).map((job) => job.name),', 'jobs: names((module.jobs ?? []).map((job) => job.name)),')
s=s.replace('queries: module.queries.map((query) => query.name),', 'queries: names(module.queries.map((query) => query.name)),')
s=s.replace('resources: [...(module.resources ?? [])],','resources: names(module.resources ?? []),')
s=s.replace('      for (const route of controller.routes) {\n        routes.push({', '''      for (const route of controller.routes) {
        const candidates = module.commands.filter(command => command.className === route.command || command.name === route.command);
        const command = candidates.length === 1 ? candidates[0]?.name : undefined;
        routes.push({''')
s=s.replace('          path: route.path,','          path: joinRoutePaths(controller.path, route.path),')
s=s.replace('...(route.command === undefined ? {} : { command: route.command }),', '...(command === undefined ? {} : { command }),')
s=s.replace('|| left.path.localeCompare(right.path, "en"));','|| left.path.localeCompare(right.path, "en")\n    || left.controller.localeCompare(right.controller, "en")\n    || left.handler.localeCompare(right.handler, "en"));')
s=s.replace('...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),', '...(Number.isSafeInteger(diagnostic.line) && diagnostic.line! > 0 ? { line: diagnostic.line } : {}),')
s=s.replace('  const boundedModules = bound(developmentModules', '''  diagnostics.sort((left, right) =>
    Number(right.severity === "error") - Number(left.severity === "error")
    || (left.file ?? "").localeCompare(right.file ?? "", "en")
    || (left.line ?? 0) - (right.line ?? 0)
    || left.code.localeCompare(right.code, "en")
    || JSON.stringify(left.repair ?? {}).localeCompare(JSON.stringify(right.repair ?? {}), "en"));

  const boundedModules = bound(developmentModules''')
s=s.replace('    `APPLICATION ${context.schema}`,', '    `APPLICATION ${context.schema}`,\n    `  source: ${context.source}; deploymentVerified: ${context.deploymentVerified}`,\n    `  omitted: ${Object.entries(context.omitted).filter(([, count]) => count > 0).map(([key, count]) => `${key}=${count}`).join(", ") || "none"}`,')
p.write_text(s)
p=Path('packages/compiler/src/index.ts');s=p.read_text().replace('  ApplicationDevelopmentDiagnostic,','  ApplicationDevelopmentDiagnostic,\n  DevelopmentSchemaKind,');p.write_text(s)
p=Path('packages/compiler/src/application-development.test.ts');s=p.read_text().replace('method: "POST", path: "/", handler: "create", command: "orders.create",','method: "POST", path: "/", handler: "create", command: "OrdersCreate",').replace('module: "orders", method: "POST", path: "/", controller:', 'module: "orders", method: "POST", path: "/orders", controller:').replace('POST / -> OrdersController.create (orders)', 'POST /orders -> OrdersController.create (orders)');p.write_text(s+'\n' if not s.endswith('\n') else s)
p=Path('docs/application-development-context.md');s=p.read_text().replace('module, method, path, controller, handler, bound command,', 'module, method, full controller-prefixed path, controller, handler, canonical bound command,').replace('credentials, tokens, request bodies', 'credentials, authentication tokens, request bodies');s=s.replace('execution-context policy.', '''execution-context policy. Only positive integer diagnostic line numbers and
allowlisted schema-kind keys are retained. Declared names (including DI provider
tokens) and tags are structural metadata, not automatically secret-detectable;
hosts must not place credentials or business payloads in metadata names.''');s=s.replace('64 diagnostics, 64 KiB output). Truncation is reported in `omitted`;', '64 diagnostics, 64 KiB output). The provider budget is document-wide, including\nproviders lost with omitted modules in the count. Other collection caps apply to\ntheir top-level arrays; module name inventories remain subject to the final byte\nbudget. Aspect and execution-stage order remains semantic, while inventories,\nresource uses and diagnostics have canonical ordering. Text output reports\nomissions and explicitly marks deployment as unverified.\n\nTruncation is reported in `omitted`;');p.write_text(s+'\n' if not s.endswith('\n') else s)
Path('packages/compiler/src/application-development-regressions.test.ts').write_text(r'''import { expect, test } from "bun:test";
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
''')
