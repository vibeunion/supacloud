import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "@typescript/typescript6";
import { compileProject, checkProject } from "./compile";
import { isScopeViolation } from "../../app/src/scope";
import { renderApplication } from "./generate";
import { validateGraph } from "./validate";
import { RUNTIME_SOURCE, FIXTURE_TSCONFIG } from "./fixtures/runtime-source";
import { writeFixtureProject } from "./fixtures/helpers";
import type { ApplicationGraph, ModuleNode, ProviderNode } from "./types";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const runtime = RUNTIME_SOURCE.replace('scope?: string; deps?: unknown[]', 'scope?: string; providedIn?: "root"; deps?: unknown[]') + `
export function Optional() { return (..._args: unknown[]) => {}; }
export function Self() { return (..._args: unknown[]) => {}; }
export function SkipSelf() { return (..._args: unknown[]) => {}; }
`;
async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), "static-framework-")); roots.push(root);
  await writeFixtureProject(root, { "tsconfig.json": FIXTURE_TSCONFIG, "src/runtime.ts": runtime, "src/main.ts": source });
  return root;
}
const options = (root: string) => ({ rootDir: join(root, "src"), outDir: join(root, "generated"), requireRouteContracts: false, strict: true });
function typecheck(root: string) {
  const program = ts.createProgram([join(root, "generated/application.ts")], {
    strict: true, noEmit: true, skipLibCheck: true, types: [], experimentalDecorators: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  return ts.getPreEmitDiagnostics(program).map(item => ts.flattenDiagnosticMessageText(item.messageText, "\n"));
}
interface CompiledModule {
  name: string;
  createServices(deps: Record<string, unknown>, imported: Record<string, Record<string, unknown>>): Record<string, unknown>;
  createRequestScope?(services: Record<string, unknown>, context: unknown, imported?: Record<string, Record<string, unknown>>): Promise<Record<string, unknown>>;
  destroyServices?(services: Record<string, unknown>): Promise<void>;
  destroyRequestScope?(services: Record<string, unknown>): Promise<void>;
}
async function modules(root: string): Promise<CompiledModule[]> {
  const loaded: { createCompiledModules(): CompiledModule[] } = await import(pathToFileURL(join(root, "generated/application.ts")).href);
  return loaded.createCompiledModules();
}

test("compiled DI resolves public re-exports, Self/SkipSelf, Optional, ordered multi providers and aliases", async () => {
  const root = await fixture(`import { Module, Injectable, Inject, InjectionToken, Self, SkipSelf, Optional, Controller } from "./runtime";
export const LABEL = new InjectionToken<string>("label");
export const MISSING = new InjectionToken<string>("missing");
export const ITEMS = new InjectionToken<Item[]>("items");
export const ALIAS = new InjectionToken<Item[]>("alias");
export const events: number[] = [];
let sequence: number = 0;
@Injectable() export class Item { readonly id = ++sequence; onDestroy() { events.push(this.id); } }
@Injectable() export class List { constructor(@Inject(ITEMS) readonly items: Item[]) {} }
@Injectable() export class Parent { constructor(@SkipSelf() @Inject(LABEL) readonly label: string, @Self() @Inject(LABEL) readonly local: string) {} }
@Injectable() export class Local { constructor(@Self() @Inject(LABEL) readonly label: string, @Self() @Optional() @Inject(MISSING) readonly absent: string | null) {} }
@Injectable({ scope: "request" }) @Controller("/") export class RequestView {
  constructor(@SkipSelf() @Inject(LABEL) readonly label: string, @Optional() @Inject(MISSING) readonly absent: string | null) {}
}
@Module({ name: "base", providers: [{provide: LABEL, useValue: "base"}], exports: [LABEL] }) export class Base {}
@Module({ name: "facade", imports: [Base], exports: [Base] }) export class Facade {}
@Module({ name: "public", imports: [Facade], exports: [LABEL] }) export class Public {}
@Module({ name: "feature", imports: [Public], providers: [
  {provide: LABEL, useValue: "local"}, Parent, Local,
  {provide: ITEMS, useClass: Item, multi: true}, List,
  {provide: ITEMS, useClass: Item, multi: true}, {provide: ALIAS, useExisting: ITEMS},
], controllers: [RequestView] }) export class Feature {}
`);
  const result = await compileProject(options(root));
  expect(result.diagnostics.filter(item => item.severity === "error")).toEqual([]);
  expect(typecheck(root)).toEqual([]);
  const descriptors = await modules(root);
  const imported: Record<string, Record<string, unknown>> = {};
  for (const module of descriptors) imported[module.name] = module.createServices({}, imported);
  const feature = imported["feature"]!;
  expect(feature["parent"]).toMatchObject({ label: "base", local: "local" });
  expect(feature["local"]).toEqual({ label: "local", absent: null });
  expect(feature["items"]).toEqual([{ id: 1 }, { id: 2 }]);
  expect(feature["alias"]).toBe(feature["items"]);
  expect(feature["list"]).toMatchObject({ items: feature["items"] });
  const descriptor = descriptors.find(module => module.name === "feature")!;
  const scope = await descriptor.createRequestScope!(feature, {}, imported);
  expect(scope["requestView"]).toEqual({ label: "local", absent: null });
  await descriptor.destroyServices!(feature);
  await descriptor.destroyServices!(feature);
  const source: { events: number[] } = await import(pathToFileURL(join(root, "src/main.ts")).href);
  expect(source.events).toEqual([2, 1]);
  const manifest: { executionPlan: { modules: Array<{ name: string; providerEdges: Array<{ from: string; to: string; relation: string }> }> } } = JSON.parse(await readFile(join(root, "generated/app.manifest.json"), "utf8"));
  expect(manifest.executionPlan.modules.find(module => module.name === "feature")?.providerEdges).toContainEqual({ from: "Parent", to: "LABEL", relation: "imported" });
}, 30_000);

test("root defaults are initialized before importing features and external dependencies fail closed", async () => {
  const root = await fixture(`import { Module, Injectable, Inject, InjectionToken, Optional } from "./runtime";
export const REQUIRED = new InjectionToken<string>("required");
export const OPTIONAL = new InjectionToken<string>("optional");
@Injectable({providedIn:"root"}) export class Defaults { readonly label = "root"; }
@Injectable() export class Consumer { constructor(readonly defaults: Defaults, @Inject(REQUIRED) readonly required: string, @Optional() @Inject(OPTIONAL) readonly optional: string | null, @Optional() @Inject(REQUIRED) readonly alsoRequired: string | null) {} }
@Module({name:"feature",providers:[Consumer]}) export class Feature {}
@Module({name:"app",imports:[Feature]}) export class App {}
`);
  const result = await compileProject(options(root));
  expect(result.diagnostics.filter(item => item.severity === "error")).toEqual([]);
  expect(typecheck(root)).toEqual([]);
  const descriptors = await modules(root);
  const imported: Record<string, Record<string, unknown>> = {};
  const rootModule = descriptors.find(module => module.name === "root")!;
  imported["root"] = rootModule.createServices({}, imported);
  const feature = descriptors.find(module => module.name === "feature")!;
  expect(descriptors.indexOf(rootModule)).toBeLessThan(descriptors.indexOf(feature));
  expect(() => feature.createServices({}, imported)).toThrow("Missing compiled dependency: REQUIRED");
  expect(() => feature.createServices(Object.create({ required: "inherited" }), imported)).toThrow("Missing compiled dependency");
  expect(feature.createServices({ required: "explicit" }, imported)["consumer"]).toMatchObject({ required: "explicit", optional: null });
  expect(feature.createServices({ required: "explicit", optional: undefined }, imported)["consumer"]).toMatchObject({ optional: undefined });
}, 30_000);

test("controller visibility, conflicting flags and sibling lifetimes are compile errors even with writeOnError", async () => {
  expect(isScopeViolation("request", "job")).toBe(true);
  expect(isScopeViolation("job", "request")).toBe(true);
  expect(isScopeViolation("request", "application")).toBe(false);
  const cases = [
    { code: "missing-deps", source: `@Injectable() export class Consumer { constructor(@Optional() readonly unbound: string | null) {} }\n@Module({name:"feature",providers:[Consumer]}) export class Feature {}` },
    { code: "module-boundary", source: `@Injectable() export class Hidden {}\n@Module({name:"private",providers:[Hidden]}) export class Private {}\n@Controller("/") export class View { constructor(readonly hidden: Hidden) {} }\n@Module({name:"feature",imports:[Private],controllers:[View]}) export class Feature {}` },
    { code: "conflicting-injection-flags", source: `export const TOKEN = new InjectionToken<string>("token");\n@Injectable() export class Consumer { constructor(@Self() @SkipSelf() @Optional() @Inject(TOKEN) readonly value: string | null) {} }\n@Module({name:"feature",providers:[Consumer]}) export class Feature {}` },
    { code: "scope-violation", source: `@Injectable({scope:"request"}) export class RequestValue {}\n@Injectable({scope:"job"}) export class Worker { constructor(readonly value: RequestValue) {} }\n@Module({name:"feature",providers:[RequestValue,Worker]}) export class Feature {}` },
    { code: "scope-violation", source: `@Injectable({scope:"request"}) export class RequestValue {}\n@Injectable({scope:"application"}) @Controller("/") export class View { constructor(readonly value: RequestValue) {} }\n@Module({name:"feature",providers:[RequestValue],controllers:[View]}) export class Feature {}` },
    { code: "scope-violation", source: `@Injectable() export class Consumer { constructor(@Inject(REQUEST_CONTEXT) readonly context: unknown) {} }\n@Module({name:"feature",providers:[Consumer]}) export class Feature {}` },
    { code: "mixed-multi-provider-scopes", source: `export const ITEMS = new InjectionToken<string[]>("items");\n@Module({name:"feature",providers:[{provide:ITEMS,useValue:"a",multi:true},{provide:ITEMS,useValue:"b",multi:true,scope:"request"}]}) export class Feature {}` },
    { code: "circular-module-import", source: `@Injectable({providedIn:"root"}) export class RootValue {}\n@Injectable() export class FeatureValue { constructor(readonly value: RootValue) {} }\n@Module({name:"feature",providers:[FeatureValue]}) export class Feature {}\n@Module({name:"app",imports:[Feature],providers:[RootValue]}) export class App {}` },
    { code: "cross-module-scoped-dependency", source: `@Injectable({scope:"request"}) export class RequestValue {}\n@Module({name:"other",providers:[RequestValue],exports:[RequestValue]}) export class Other {}\n@Injectable({scope:"request"}) @Controller("/") export class View { constructor(readonly value: RequestValue) {} }\n@Module({name:"feature",imports:[Other],controllers:[View]}) export class Feature {}` },
  ];
  for (const item of cases) {
    const root = await fixture('import { Module, Injectable, Controller, Inject, InjectionToken, Optional, Self, SkipSelf, REQUEST_CONTEXT } from "./runtime";\n' + item.source);
    const result = await compileProject({ ...options(root), writeOnError: true });
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain(item.code);
    expect(result.written).toEqual([]);
    const checked = await checkProject({ ...options(root), writeOnError: true });
    expect(checked.upToDate).toBe(false);
    expect(checked.diagnostics.map(diagnostic => diagnostic.code)).toContain(item.code);
  }
}, 60_000);

test("ambiguous module imports fail while diamond re-exports preserve one provider", () => {
  const provider = (value: string): ProviderNode => ({ token: "PORT", tokenKind: "injection-token", kind: "value", useValueExpr: JSON.stringify(value), scope: "application", deps: [], exported: true, file: "source.ts", line: 1 });
  const module = (name: string, providers: ProviderNode[] = [], imports: string[] = [], exports: string[] = []): ModuleNode => ({ name, className: name, file: "source.ts", line: 1, imports, exports, providers, controllers: [], commands: [], queries: [] });
  const consumer: ProviderNode = { token: "Consumer", tokenKind: "class", kind: "class", useClass: "Consumer", scope: "application", deps: ["PORT"], exported: false, file: "source.ts", line: 1 };
  const graph: ApplicationGraph = { externalTokens: [], modules: [module("a", [provider("a")], [], ["PORT"]), module("b", [provider("b")], [], ["PORT"]), module("feature", [consumer], ["a", "b"])] };
  expect(validateGraph(graph).some(item => item.code === "ambiguous-dependency")).toBe(true);
  graph.modules[1] = module("b", [], ["a"], ["PORT"]);
  expect(validateGraph(graph).filter(item => item.severity === "error")).toEqual([]);
  expect(renderApplication(graph, { rootDir: ".", outDir: "generated" }).executionPlan.modules.find(item => item.name === "feature")?.providerEdges).toContainEqual({ from: "Consumer", to: "PORT", relation: "imported" });
});

test("typed aspects must be immutable references bound to the declared operation", async () => {
  const prefix = `import { Module, Command, defineOperationAspect } from "@supacloud/app/core";
const decode = (value: unknown): unknown => value;
`;
  for (const [declaration, target, expected] of [
    ['export const aspect = defineOperationAspect({kind:"command",name:"orders.approve",input:decode,result:decode,capabilities:()=>({})},async (_context,next)=>next());', 'orders.approve', undefined],
    ['export const aspect = defineOperationAspect({kind:"command",name:"orders.approve",input:decode,result:decode,capabilities:()=>({})},async (_context,next)=>next());', 'orders.reject', "aspect-operation-mismatch"],
    ['export let aspect = defineOperationAspect({kind:"command",name:"orders.approve",input:decode,result:decode,capabilities:()=>({})},async (_context,next)=>next());', 'orders.approve', "invalid-aspect-reference"],
    ['const override = { name:"orders.reject" }; export const aspect = defineOperationAspect({kind:"command",name:"orders.approve",input:decode,result:decode,capabilities:()=>({}),...override},async (_context,next)=>next());', 'orders.approve', "invalid-aspect-reference"],
  ] as const) {
    const root = await fixture(prefix + declaration + `\n@Command({name:${JSON.stringify(target)},permission:"orders:approve",aspects:[aspect]}) export class Approve {}\n@Module({name:"orders",commands:[Approve]}) export class Orders {}`);
    // A real package link preserves symbol origin while keeping fixture application code isolated.
    await mkdir(join(root, "node_modules/@supacloud"), { recursive: true });
    await symlink(resolve(import.meta.dir, "../../app"), join(root, "node_modules/@supacloud/app"));
    const result = await compileProject({ ...options(root), writeOnError: true, commandCapabilities: { requirePersistentAdapters: false } });
    if (expected) { expect(result.diagnostics.some(item => item.code === expected)).toBe(true); expect(result.written).toEqual([]); }
    else expect(result.diagnostics.filter(item => item.severity === "error")).toEqual([]);
  }
}, 60_000);


test("request scopes are isolated and failed construction rolls back owned instances once", async () => {
  const root = await fixture(`import { Module, Injectable, Inject, InjectionToken, REQUEST_CONTEXT } from "./runtime";
export const destroyed: string[] = [];
export const ITEMS = new InjectionToken<string[]>("items");
export const ALIAS = new InjectionToken<string[]>("alias");
@Injectable({scope:"request"}) export class ContextValue {
  constructor(@Inject(REQUEST_CONTEXT) readonly context: { id: string; fail?: boolean }) {}
  onDestroy() { destroyed.push(this.context.id); }
}
@Injectable({scope:"request"}) export class Guarded {
  constructor(readonly value: ContextValue, @Inject(ITEMS) readonly items: string[]) { if(value.context.fail) throw new Error("construction failed"); }
}
@Module({name:"feature",providers:[ContextValue,Guarded,
  {provide: ITEMS,useValue:"first",scope:"request",multi:true},
  {provide: ITEMS,useValue:"second",scope:"request",multi:true},
  {provide: ALIAS,useExisting:ITEMS,scope:"request"},
]}) export class Feature {}
`);
  const result = await compileProject(options(root));
  expect(result.diagnostics.filter(item => item.severity === "error")).toEqual([]);
  expect(typecheck(root)).toEqual([]);
  const descriptor = (await modules(root))[0]!;
  const services = descriptor.createServices({}, {});
  const [first, second] = await Promise.all([
    descriptor.createRequestScope!(services, { id: "first" }),
    descriptor.createRequestScope!(services, { id: "second" }),
  ]);
  expect(first["items"]).toEqual(["first", "second"]);
  expect(first["alias"]).toBe(first["items"]);
  expect(first["guarded"]).toMatchObject({ items: first["items"] });
  expect(first["items"]).not.toBe(second["items"]);
  expect(first["contextValue"]).not.toBe(second["contextValue"]);
  expect(first["guarded"]).toMatchObject({ value: first["contextValue"] });
  expect(second["guarded"]).toMatchObject({ value: second["contextValue"] });
  await expect(descriptor.createRequestScope!(services, { id: "failed", fail: true })).rejects.toThrow("construction failed");
  await Promise.all([descriptor.destroyRequestScope!(first), descriptor.destroyRequestScope!(first)]);
  await descriptor.destroyRequestScope!(second);
  const source: { destroyed: string[] } = await import(pathToFileURL(join(root, "src/main.ts")).href);
  expect(source.destroyed).toEqual(["failed", "first", "second"]);
}, 30_000);
