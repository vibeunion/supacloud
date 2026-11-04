import type { CompiledRouteRegistrar } from "./index";
import { expect, test } from "bun:test";
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
