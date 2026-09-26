import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { renderApplication } from "./generate";
import { writeFixtureProject } from "./fixtures/helpers";
import type { ApplicationGraph } from "./types";
import { validateGraph } from "./validate";

test("request and job scopes borrow isolated platform dependencies without owning their lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-external-scope-"));
  try {
    const graph: ApplicationGraph = {
      externalTokens: ["EXTERNAL", "OPTIONAL_EXTERNAL", "REQUEST_CONTEXT", "JOB_CONTEXT"],
      modules: [{
        name: "example", className: "ExampleModule", file: "source.ts", line: 1,
        imports: [], exports: [], commands: [], queries: [],
        providers: [{
          token: "JobWorker", kind: "class", tokenKind: "class", useClass: "JobWorker",
          importPath: "source", scope: "job",
          deps: ["EXTERNAL", "JOB_CONTEXT", "OPTIONAL_EXTERNAL"], optionalDeps: ["OPTIONAL_EXTERNAL"],
          exported: false, file: "source.ts", line: 1,
        }],
        controllers: [{
          className: "RequestController", path: "/", scope: "request",
          deps: ["EXTERNAL", "REQUEST_CONTEXT", "OPTIONAL_EXTERNAL"], optionalDeps: ["OPTIONAL_EXTERNAL"],
          importPath: "source", file: "source.ts", routes: [{ method: "GET", path: "/", handler: "get" }],
        }],
      }],
    };
    expect(validateGraph(graph).filter((item) => item.severity === "error")).toEqual([]);
    const rendered = renderApplication(graph, { rootDir: root, outDir: join(root, "generated") });
    await writeFixtureProject(root, {
      "source.ts": `
export class RequestController {
  constructor(readonly external: unknown, readonly context: unknown, readonly optional: unknown) {}
  get() { return this.external; }
}
export class JobWorker {
  constructor(readonly external: unknown, readonly context: unknown, readonly optional: unknown) {}
}
`,
      "generated/application.ts": rendered.applicationCode,
    });
    const generated = await import(pathToFileURL(join(root, "generated/application.ts")).href);
    const [module] = generated.createCompiledModules();
    let destroyed = 0;
    const firstExternal = { identity: "first", onDestroy() { destroyed++; } };
    const secondExternal = { identity: "second", onDestroy() { destroyed++; } };
    const firstServices = module.createServices({ external: firstExternal }, {});
    const secondServices = module.createServices({ external: secondExternal, optionalExternal: false }, {});
    expect(Object.keys(firstServices)).toEqual([]);
    expect(Object.keys(secondServices)).toEqual([]);
    for (const [services, external, optional] of [
      [firstServices, firstExternal, undefined], [secondServices, secondExternal, false],
    ]) {
      const context = { requestId: Math.random() };
      const scope = await module.createRequestScope(services, context);
      expect(scope.requestController.external).toBe(external);
      expect(scope.requestController.context).toBe(context);
      expect(scope.requestController.optional).toBe(optional);
      const job = await module.createJobScope(services, context);
      expect(job.jobWorker.external).toBe(external);
      expect(job.jobWorker.context).toBe(context);
      expect(job.jobWorker.optional).toBe(optional);
      await module.destroyRequestScope(scope);
      await module.destroyJobScope(job);
      await generated.destroyApplication(services);
    }
    expect(destroyed).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scoped optional and skip-self dependencies respect local, imported and platform precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-scope-precedence-"));
  try {
    const graph: ApplicationGraph = {
      externalTokens: [],
      modules: [{
        name: "parent", className: "ParentModule", file: "source.ts", line: 1,
        imports: [], exports: ["CONFIG"], commands: [], queries: [], controllers: [],
        providers: [{
          token: "CONFIG", kind: "value", tokenKind: "injection-token", useValueExpr: '"parent"',
          scope: "application", deps: [], exported: true, file: "source.ts", line: 1,
        }],
      }, ...["withParent", "withoutParent"].map((name) => ({
        name, className: "ExampleModule", file: "source.ts", line: 1,
        imports: name === "withParent" ? ["parent"] : [], exports: [], commands: [], queries: [],
        providers: [{
          token: "CONFIG", kind: "value" as const, tokenKind: "injection-token" as const,
          useValueExpr: '"local"', scope: "application" as const, deps: [],
          exported: false, file: "source.ts", line: 1,
        }, ...["LocalWorker", "ParentWorker"].map((token) => ({
          token, kind: "class" as const, tokenKind: "class" as const, useClass: token,
          importPath: "source", scope: "job" as const, deps: ["CONFIG"], optionalDeps: ["CONFIG"],
          ...(token === "ParentWorker" ? { skipSelfDeps: ["CONFIG"] } : {}),
          exported: false, file: "source.ts", line: 1,
        }))],
        controllers: ["LocalController", "ParentController"].map((className) => ({
          className, path: `/${name}/${className}`, scope: "request" as const, deps: ["CONFIG"], optionalDeps: ["CONFIG"],
          ...(className === "ParentController" ? { skipSelfDeps: ["CONFIG"] } : {}),
          importPath: "source", file: "source.ts", routes: [{ method: "GET" as const, path: "/", handler: "get" }],
        })),
      }))],
    };
    expect(validateGraph(graph).filter((item) => item.severity === "error")).toEqual([]);
    const rendered = renderApplication(graph, { rootDir: root, outDir: join(root, "generated") });
    const classes = ["LocalController", "ParentController", "LocalWorker", "ParentWorker"];
    await writeFixtureProject(root, {
      "source.ts": classes.map((name) =>
        `export class ${name} { constructor(readonly config: unknown) {} get() { return this.config; } }`).join("\n"),
      "generated/application.ts": rendered.applicationCode,
    });
    const generated = await import(pathToFileURL(join(root, "generated/application.ts")).href);
    const [parent, ...children] = generated.createCompiledModules();
    const imported = { parent: parent.createServices({}, {}) };
    for (const child of children) {
      const services = child.createServices({ config: "platform" }, imported);
      const request = await child.createRequestScope(services, {}, imported);
      const job = await child.createJobScope(services, {}, imported);
      expect(request.localController.config).toBe("local");
      expect(job.localWorker.config).toBe("local");
      const inherited = child.name === "withParent" ? "parent" : "platform";
      expect(request.parentController.config).toBe(inherited);
      expect(job.parentWorker.config).toBe(inherited);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
