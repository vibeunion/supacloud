import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "@typescript/typescript6";
import { renderApplication } from "./generate";
import { compileProject } from "./compile";
import { scanRuntimeDi } from "./static-di";
import { writeFixtureProject } from "./fixtures/helpers";
import { RUNTIME_SOURCE, FIXTURE_TSCONFIG } from "./fixtures/runtime-source";
import type { ApplicationGraph } from "./types";

test("runtime DI is rejected through aliases and namespaces without confusing declarations", () => {
  const diagnostics = scanRuntimeDi(ts.createSourceFile("main.ts", `
import { inject as resolve, Module } from "@supacloud/app";
import * as app from "@supacloud/app";
const a = app.createEnvironmentInjector([]);
const b = app["inject"];
`, ts.ScriptTarget.Latest, true), "main.ts");
  expect(diagnostics.map((item) => item.errorCode)).toEqual(["SC2012", "SC2012", "SC2012"]);
  expect(scanRuntimeDi(ts.createSourceFile("main.ts", `
import { Inject, Injectable, Module } from "@supacloud/app";
import type { EnvironmentInjector } from "@supacloud/app";
`, ts.ScriptTarget.Latest, true), "main.ts")).toEqual([]);
});

test("compile refuses property injection even with writeOnError", async () => {
  const root = await mkdtemp(join(tmpdir(), "static-di-gate-"));
  try {
    await writeFixtureProject(root, {
      "tsconfig.json": FIXTURE_TSCONFIG,
      "runtime.ts": RUNTIME_SOURCE + "\nexport function inject<T>(token: InjectionToken<T>): T { throw new Error('runtime'); }",
      "main.ts": `import { Injectable, InjectionToken, Module, inject } from "./runtime";
export const DB = new InjectionToken("db");
@Injectable() export class Repo { db = inject(DB); }
@Module({ name: "orders", providers: [Repo] }) export class OrdersModule {}`,
    });
    const result = await compileProject({ rootDir: root, outDir: join(root, "generated"), writeOnError: true });
    expect(result.diagnostics.some((item) => item.errorCode === "SC2012")).toBe(true);
    expect(result.written).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("generated static AOP executes in order, rejects reused continuations and cleans concurrent scopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "static-aop-"));
  try {
    const aspect = (name: string) => ({ name, expression: name, importPath: "source" });
    const graph: ApplicationGraph = {
      externalTokens: ["REQUEST_CONTEXT"],
      modules: [{
        name: "orders", className: "OrdersModule", file: "source.ts", line: 1,
        imports: [], exports: [], controllers: [], commands: [], queries: [],
        aspects: [aspect("outer"), aspect("inner")],
        providers: [{
          token: "Worker", tokenKind: "class", kind: "class", useClass: "Worker", importPath: "source",
          scope: "request", deps: ["REQUEST_CONTEXT"], hasOnDestroy: true,
          file: "source.ts", line: 1, exported: false,
        }],
      }],
    };
    const code = renderApplication(graph, { rootDir: root, outDir: join(root, "generated") }).applicationCode;
    expect(code).not.toContain("runInInjectionContext");
    expect(code).not.toContain("injector.get");
    expect(code).toContain("outer(context, step1)");
    await writeFixtureProject(root, {
      "generated/application.ts": code,
      "source.ts": `
export const events: string[] = [];
interface Context { input: unknown }
export class Worker {
  constructor(readonly context: { id: string }) {}
  onDestroy() { events.push("destroy:" + this.context.id); }
}
export async function outer(_ctx: Context, next: () => unknown) {
  events.push("outer:before");
  try { return await next(); } finally { events.push("outer:after"); }
}
export async function inner(ctx: Context, next: () => unknown) {
  events.push("inner:before");
  if (ctx.input === "deny") throw new Error("denied");
  const result = await next();
  if (ctx.input === "twice") await next();
  events.push("inner:after");
  return result;
}`,
      "runner.ts": `
import { createCompiledModules } from "./generated/application";
import { events } from "./source";
export async function run(mode: string) {
  events.length = 0;
  const module = createCompiledModules()[0];
  if (!module?.createRequestScope || !module.destroyRequestScope || !module.aspectPipeline) throw new Error("Missing generated entry");
  const services = module.createServices({}, {});
  const [a, b] = await Promise.all([
    module.createRequestScope(services, { id: "a" }),
    module.createRequestScope(services, { id: "b" }),
  ]);
  let calls = 0, error: string | undefined;
  try {
    await module.aspectPipeline({ kind: "command", name: "orders.run", input: mode }, () => ++calls);
  } catch (cause) { error = cause instanceof Error ? cause.message : "unknown"; }
  finally {
    await module.destroyRequestScope(a); await module.destroyRequestScope(b);
    await module.destroyRequestScope(a);
  }
  return { calls, error, events: [...events], distinct: a.worker !== b.worker };
}`,
    });
    const program = ts.createProgram([join(root, "runner.ts")], {
      strict: true, noEmit: true, skipLibCheck: true, types: [],
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    });
    expect(ts.getPreEmitDiagnostics(program).map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n"))).toEqual([]);
    const loaded: unknown = await import(pathToFileURL(join(root, "runner.ts")).href);
    if (!loaded || typeof loaded !== "object" || !("run" in loaded) || typeof loaded.run !== "function") throw new Error("Missing runner");
    expect(await loaded.run("ok")).toEqual({
      calls: 1, error: undefined, distinct: true,
      events: ["outer:before", "inner:before", "inner:after", "outer:after", "destroy:a", "destroy:b"],
    });
    expect(await loaded.run("twice")).toMatchObject({ calls: 1, error: "Aspect continuation called multiple times" });
    expect(await loaded.run("deny")).toMatchObject({ calls: 0, error: "denied" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
