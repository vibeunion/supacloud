import type { CompiledRouteRegistrar } from "./index";
import { expect, test } from "bun:test";
import { t } from "elysia";
import { Effect } from "effect";
import { createApplication, type CompiledModule, type CompiledRoute } from "./index";
import { createBunAotApplication } from "./bun-aot";

test("Bun AOT adapter preserves the full Elysia application path", async () => {
  const app = createBunAotApplication({
    modules: [{
      name: "aot-test",
      createServices: () => ({ controller: { read: () => ({ ok: true }) } }),
      registerRoutes(register: CompiledRouteRegistrar) {
        register(this.controllers[0]!, this.controllers[0]!.routes[0]!, "/health");
      },
      controllers: [{
        path: "",
        serviceKey: "controller",
        scope: "application",
        routes: [{
          method: "GET",
          path: "/health",
          handler: "read",
          invoker: (controller) => controller.read(),
        }],
      }],
    }],
  });
  const response = await app.fetch(new Request("http://localhost/health"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  await app.destroy();
});

test("compiler-selected direct routes receive Elysia's decoded context without an input envelope", async () => {
  const app = createBunAotApplication({
    modules: [{
      name: "direct-test",
      createServices: () => ({ controller: {
        read: (...args: unknown[]) => ({ argumentCount: args.length }),
        echo: (body: unknown) => body,
      } }),
      registerRoutes(register: CompiledRouteRegistrar) {
        register(this.controllers[0]!, this.controllers[0]!.routes[0]!, "/direct");
        register(this.controllers[0]!, this.controllers[0]!.routes[1]!, "/echo");
      },
      controllers: [{
        path: "",
        serviceKey: "controller",
        scope: "application",
        routes: [
          {
            method: "GET",
            path: "/direct",
            handler: "read",
            executionMode: "direct",
            directInvoker: (controller) => controller.read(),
            invoker: (controller) => controller.read(),
          },
          {
            method: "POST",
            path: "/echo",
            handler: "echo",
            executionMode: "pipeline",
            invoker: (controller, request) => controller.echo(request.body),
          },
        ],
      }],
    }],
  });
  const direct = await app.fetch(new Request("http://localhost/direct"));
  expect(await direct.json()).toEqual({ argumentCount: 0 });
  const echo = await app.fetch(new Request("http://localhost/echo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true }),
  }));
  expect(await echo.json()).toEqual({ ok: true });
  await app.destroy();
});

// I have nothing but my burger and I want nothing more

test("fast invokers preserve decoded params, body, this, async results and error mapping", async () => {
  const controller = {
    prefix: "item:",
    read(id: unknown) { return { id: `${this.prefix}${id}` }; },
    echo: async (body: unknown) => body,
    fail() { throw new Error("private detail"); },
  };
  const routes: CompiledRoute[] = [
    { method: "GET", path: "/:id", handler: "read", params: t.Object({ id: t.String() }),
      executionMode: "direct", directInvoker: () => { throw new Error("slow invoker called"); },
      directInvokerFast: (instance, handler, context) => handler.call(instance, (context as { params: { id: string } }).params.id) },
    { method: "POST", path: "/echo", handler: "echo", body: t.Object({ value: t.Number() }),
      executionMode: "direct", directInvoker: () => { throw new Error("slow invoker called"); },
      directInvokerFast: (instance, handler, context) => handler.call(instance, (context as { body: unknown }).body) },
    { method: "GET", path: "/fail", handler: "fail", executionMode: "direct",
      directInvoker: () => controller.fail(), directInvokerFast: (instance, handler) => handler.call(instance) },
  ];
  const app = createApplication({ modules: [{ name: "fast", createServices: () => ({ controller }),
    registerRoutes(register: CompiledRouteRegistrar) {
      for (const route of routes) register(this.controllers[0]!, route, route.path);
    },
    controllers: [{ path: "", scope: "application", serviceKey: "controller", routes }] }] });
  try {
    const response = await app.fetch(new Request("http://localhost/42"));
    expect(await response.json()).toEqual({ id: "item:42" });
    const echo = await app.fetch(new Request("http://localhost/echo", { method: "POST",
      headers: { "content-type": "application/json" }, body: '{"value":0}' }));
    expect(await echo.json()).toEqual({ value: 0 });
    const invalid = await app.fetch(new Request("http://localhost/echo", { method: "POST",
      headers: { "content-type": "application/json" }, body: '{"value":"invalid"}' }));
    expect(invalid.status).toBe(422);
    const failed = await app.fetch(new Request("http://localhost/fail"));
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("private detail");
  } finally { await app.destroy(); }
});

for (const mode of ["module-aspect", "route-aspect", "effect", "response-map", "request-scope", "command", "observer"] as const) {
  test(`direct hints cannot bypass ${mode} semantics`, async () => {
    const events: string[] = [];
    const route: CompiledRoute = {
      method: "POST", path: "/guarded", handler: "read", executionMode: "direct",
      body: t.Object({ value: t.Number() }),
      directInvoker: () => { throw new Error("must use pipeline"); },
      directInvokerFast: () => { throw new Error("must use pipeline"); },
      invoker: (_controller, input) => {
        events.push("handler");
        expect(input.body).toEqual({ value: 42 });
        expect(input.context).toBeDefined();
        return mode === "effect" ? Effect.succeed({ ok: true }) : { ok: true };
      },
    };
    const aspect = (context: { input: unknown }, next: () => unknown | Promise<unknown>) => {
      expect(context.input).toMatchObject({ body: { value: 42 }, request: expect.any(Request), requestContext: expect.anything() });
      events.push("aspect");
      return next();
    };
    const module: CompiledModule = { name: `guarded-${mode}`, createServices: () => ({ controller: { read() {} } }),
      registerRoutes(register: CompiledRouteRegistrar) {
        register(this.controllers[0]!, route, route.path);
      },
      controllers: [{ path: "", scope: "application", serviceKey: "controller", routes: [route] }] };
    if (mode === "module-aspect") module.aspects = [aspect];
    if (mode === "route-aspect") route.aspects = [aspect];
    if (mode === "effect") route.effect = { required: true };
    if (mode === "response-map") route.responses = { 201: t.Object({ ok: t.Boolean() }) };
    if (mode === "request-scope") module.createRequestScope = () => { events.push("scope"); return {}; };
    if (mode === "command") {
      route.command = "ReadCommand";
      module.commands = [{ className: "ReadCommand", name: "read", permission: "read", transaction: "none", idempotency: "none" }];
    }
    const app = createApplication({ modules: [module],
      ...(mode === "observer" ? { onExecution: () => { events.push("observe"); } } : {}),
      ...(mode === "command" ? { commandExecutor: (_invocation, next) => { events.push("command"); return next(); } } : {}),
    });
    try {
      const response = await app.fetch(new Request("http://localhost/guarded", { method: "POST",
        headers: { "content-type": "application/json" }, body: '{"value":42}' }));
      expect(response.status).toBe(mode === "response-map" ? 500 : 200);
      if (mode !== "response-map") expect(await response.json()).toEqual({ ok: true });
      expect(events).toContain("handler");
      if (mode.endsWith("aspect")) expect(events).toContain("aspect");
      if (mode === "request-scope") expect(events).toContain("scope");
      if (mode === "command") expect(events).toContain("command");
      if (mode === "observer") expect(events).toContain("observe");
    } finally { await app.destroy(); }
  });
}
