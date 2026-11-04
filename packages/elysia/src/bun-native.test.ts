import { expect, test } from "bun:test";
import { Type } from "typebox";
import { createBunNativeApplication, type CompiledModule } from "./index";

function moduleFixture(): CompiledModule {
  return {
    name: "native-test",
    createServices: () => ({ controller: {
      json: () => ({ ok: true }),
      params: (id: string) => ({ ok: true, id }),
      echo: (body: { value: number }) => ({ ok: true, value: body.value }),
    } }),
    controllers: [{
      path: "",
      serviceKey: "controller",
      scope: "application",
      routes: [
        { method: "GET", path: "/json", handler: "json", response: Type.Object({ ok: Type.Boolean() }), invoker: (controller) => controller.json() },
        { method: "GET", path: "/params/:id", handler: "params", params: Type.Object({ id: Type.String() }), invoker: (controller, input) => controller.params(input.params?.id) },
        { method: "POST", path: "/echo", handler: "echo", body: Type.Object({ value: Type.Number() }), invoker: (controller, input) => controller.echo(input.body) },
      ],
    }],
  };
}

test("native Bun application executes generated invokers without Elysia", async () => {
  const app = createBunNativeApplication({ modules: [moduleFixture()] });
  const response = await app.fetch(new Request("http://localhost/json"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});

test("native Bun application decodes and validates path and body contracts", async () => {
  const app = createBunNativeApplication({ modules: [moduleFixture()] });
  const pathResponse = await app.fetch(new Request("http://localhost/params/test"));
  expect(await pathResponse.json()).toEqual({ ok: true, id: "test" });
  const bodyResponse = await app.fetch(new Request("http://localhost/echo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: 42 }),
  }));
  expect(await bodyResponse.json()).toEqual({ ok: true, value: 42 });
  const invalid = await app.fetch(new Request("http://localhost/echo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "42" }),
  }));
  expect(invalid.status).toBe(422);
});

test("native Bun application rejects routes without generated invokers", () => {
  const module = moduleFixture();
  module.controllers[0]!.routes.push({ method: "GET", path: "/missing", handler: "missing" } as never);
  expect(() => createBunNativeApplication({ modules: [module] })).toThrow("requires a generated invoker");
});

test("native Bun application rejects complex routes that require the parity adapter", () => {
  const module = moduleFixture();
  module.controllers[0]!.routes.push({
    method: "POST", path: "/command", handler: "echo", command: "Write", invoker: (controller, input) => controller.echo(input.body),
  });
  expect(() => createBunNativeApplication({ modules: [module] })).toThrow("full-parity Bun AOT adapter");
});
