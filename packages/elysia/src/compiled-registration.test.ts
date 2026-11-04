import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { renderApplication } from "../../compiler/src/generate";
import { requireValue, writeFixtureProject } from "../../compiler/src/fixtures/helpers";
import type { ApplicationGraph, CompiledExecutionManifest } from "../../compiler/src/types";
import { ApplicationError, createModulePlugin, type CompiledModule } from "./index";

test("static registration mounts generated routes and refuses pre-migration HTTP descriptors", async () => {
  const root = await mkdtemp(join(tmpdir(), "static-registration-"));
  try {
    const graph: ApplicationGraph = { externalTokens: [], modules: [{
      name: "http", className: "HttpModule", file: "source.ts", line: 1,
      imports: [], exports: [], providers: [], commands: [], queries: [],
      controllers: [{ className: "Probe", path: "/api/", scope: "application", deps: [],
        file: "source.ts", importPath: "source", routes: [
          { method: "GET", path: "/health", handler: "read" },
          { method: "POST", path: "/echo", handler: "echo", handlerParams: [{ name: "body", kind: "body" }] },
        ] }],
    }] };
    const rendered = renderApplication(graph, { rootDir: root, outDir: join(root, "generated") });
    await writeFixtureProject(root, {
      "generated/application.ts": rendered.applicationCode,
      "source.ts": "export class Probe { read() { return 'ready'; } echo(body: unknown) { return body; } }",
    });
    const generated = await import(pathToFileURL(join(root, "generated/application.ts")).href) as {
      createCompiledModules(): CompiledModule[];
    };
    const module = requireValue(generated.createCompiledModules()[0]);
    const paths: string[] = [];
    module.registerRoutes?.((controller, route, path) => {
      expect(controller).toBe(module.controllers[0]);
      expect(controller.routes).toContain(route);
      paths.push(path);
    });
    expect(paths).toEqual(["/api/health", "/api/echo"]);
    const plan = (JSON.parse(rendered.manifestJson) as { executionPlan: CompiledExecutionManifest }).executionPlan;
    expect(plan.modules[0]?.routes.map(route => route.invoker)).toEqual(["direct", "direct"]);
    expect(plan.modules[0]?.plugin.macros).toEqual([]);
    expect(plan.modules[0]?.routes.map(route => route.path)).toEqual(paths);
    const app = createModulePlugin(module, module.createServices({}, {}));
    expect(await (await app.handle(new Request("http://localhost/api/health"))).text()).toBe("ready");
    expect(await (await app.handle(new Request("http://localhost/api/echo", {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"ok":true}',
    }))).json()).toEqual({ ok: true });
    const old = { ...module };
    delete old.registerRoutes;
    expect(() => createModulePlugin(old, {})).toThrow("Upgrade @supacloud/compiler with @supacloud/elysia");
    try { createModulePlugin(old, {}); } catch (error) {
      expect(error).toMatchObject({ code: "COMPILED_ROUTE_REGISTRATION_REQUIRED" });
    }
    expect(() => createModulePlugin({ ...module, registerRoutes(register) {
      register(this.controllers[0]!, this.controllers[0]!.routes[0]!, "/wrong-path");
    } }, {})).toThrow("Invalid static route registration");
    const invalid = { ...module };
    Object.assign(invalid, { registerRoutes: "invalid" });
    expect(() => createModulePlugin(invalid, {})).toThrow("requires a compiler-emitted registerRoutes plan");
    expect(() => createModulePlugin({ ...module, registerRoutes: () => {} }, {})).toThrow("Incomplete static route registration");
    expect(() => createModulePlugin({ ...module, registerRoutes(register) {
      register(this.controllers[0]!, this.controllers[0]!.routes[0]!, "/api/health");
      register(this.controllers[0]!, this.controllers[0]!.routes[0]!, "/api/health");
    } }, module.createServices({}, {}))).toThrow("Invalid static route registration");
    expect(() => createModulePlugin({ ...module, registerRoutes(register) {
      const controller = this.controllers[0]!;
      register(controller, { ...controller.routes[0]! }, "/unvalidated");
    } }, {})).toThrow("Invalid static route registration");
    expect(() => createModulePlugin({ name: "worker-only", controllers: [], createServices: () => ({}) }, {})).not.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("static registration keeps authorization outside command aspects and request cleanup", async () => {
  const events: string[] = [];
  const compiled: CompiledModule = {
    name: "governed", createServices: () => ({}),
    createRequestScope: () => ({ controller: { run: () => { events.push("handler"); return "done"; } } }),
    destroyRequestScope: async () => { events.push("cleanup"); },
    aspects: [(_context, next) => { events.push("aspect"); return next(); }],
    commands: [{ className: "Update", name: "orders.update", permission: "orders.write", transaction: "none", idempotency: "none" }],
    controllers: [{ path: "/", serviceKey: "controller", scope: "request", routes: [{
      method: "POST", path: "/update", handler: "run", command: "Update",
      invoker: (controller) => {
        if (!controller || typeof controller !== "object" || !("run" in controller) || typeof controller.run !== "function") throw new Error("Missing fixture controller");
        return controller.run();
      },
    }] }],
    registerRoutes(register) { register(this.controllers[0]!, this.controllers[0]!.routes[0]!, "/update"); },
  };
  let allowed = false;
  const app = createModulePlugin(compiled, {}, undefined, { commandGovernance: { authorize: () => {
    events.push("authorize");
    if (!allowed) throw new ApplicationError("Denied", { status: 403, code: "DENIED" });
  } } });
  const request = () => new Request("http://localhost/update", { method: "POST" });
  expect((await app.handle(request())).status).toBe(403);
  await Bun.sleep(0);
  expect(events).toEqual(["authorize", "cleanup"]);
  events.length = 0;
  allowed = true;
  expect(await (await app.handle(request())).text()).toBe("done");
  await Bun.sleep(0);
  expect(events).toEqual(["authorize", "aspect", "handler", "cleanup"]);
});
