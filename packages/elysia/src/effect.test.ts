import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { Elysia } from "elysia";
import { createModulePlugin } from "./index";
import { createDefaultEffectRuntime, runCompiledEffect } from "./effect";
import type { CompiledModule } from "./index";

test("runs successful Effect programs at the HTTP boundary", async () => {
  await expect(runCompiledEffect(
    Effect.succeed({ ok: true }),
    { required: true, dependencies: [] },
  )).resolves.toEqual({ ok: true });
});

test("maps tagged Effect failures to the declared public error", async () => {
  await expect(runCompiledEffect(
    Effect.fail({ _tag: "OrderNotFound" }),
    {
      required: true,
      errors: [{ tag: "OrderNotFound", status: 404, code: "ORDER_NOT_FOUND" }],
    },
  )).rejects.toMatchObject({
    status: 404,
    code: "ORDER_NOT_FOUND",
    expose: true,
  });
});

test("enforces timeout and rejects non-Effect route results", async () => {
  await expect(runCompiledEffect(
    Effect.sleep("20 millis"),
    { required: true, timeoutMs: 1 },
  )).rejects.toMatchObject({ status: 504, code: "EFFECT_TIMEOUT" });
  await expect(runCompiledEffect(
    { ok: true },
    { required: true },
  )).rejects.toMatchObject({ code: "EFFECT_PROGRAM_REQUIRED" });
});

test("supports explicit bounded retries", async () => {
  let attempts = 0;
  const program = Effect.suspend(() => {
    attempts += 1;
    return attempts < 3 ? Effect.fail("temporary") : Effect.succeed("ok");
  });
  await expect(runCompiledEffect(
    program,
    { required: true, retry: "explicit", maxAttempts: 3 },
    createDefaultEffectRuntime(),
  )).resolves.toBe("ok");
  expect(attempts).toBe(3);
});

test("executes compiled Effect routes through the Elysia adapter", async () => {
  const module: CompiledModule = {
    name: "effect-route",
    createServices: () => ({
      controller: {
        get: () => Effect.succeed({ ok: true }),
        fail: () => Effect.fail({ _tag: "OrderNotFound" }),
      },
    }),
    controllers: [{
      path: "/orders",
      serviceKey: "controller",
      scope: "application",
      routes: [
        {
          method: "GET",
          path: "/",
          handler: "get",
          effect: { required: true, errors: [{ tag: "OrderNotFound", status: 404, code: "ORDER_NOT_FOUND" }] },
        },
        {
          method: "GET",
          path: "/missing",
          handler: "fail",
          effect: { required: true, errors: [{ tag: "OrderNotFound", status: 404, code: "ORDER_NOT_FOUND" }] },
        },
      ],
    }],
    commands: [],
  };
  const app = new Elysia().use(createModulePlugin(module, module.createServices({}, {}), undefined, {
    effectRuntime: createDefaultEffectRuntime(),
  }));
  const success = await app.handle(new Request("http://localhost/orders/"));
  expect({ status: success.status, body: await success.json() }).toEqual({
    status: 200,
    body: { ok: true },
  });
  const failure = await app.handle(new Request("http://localhost/orders/missing"));
  expect({ status: failure.status, body: await failure.json() }).toEqual({
    status: 404,
    body: { ok: false, code: "ORDER_NOT_FOUND", message: "ORDER_NOT_FOUND" },
  });
});

test("requires an explicit runtime when the compiled Effect needs services", () => {
  const module: CompiledModule = {
    name: "effect-dependency",
    createServices: () => ({ controller: { get: () => Effect.succeed("ok") } }),
    controllers: [{
      path: "/orders",
      serviceKey: "controller",
      scope: "application",
      routes: [{
        method: "GET",
        path: "/",
        handler: "get",
        effect: { required: true, dependencies: ["OrderApi"] },
      }],
    }],
    commands: [],
  };
  expect(() => createModulePlugin(module, module.createServices({}, {}))).toThrow(
    "declares Effect dependencies without an effectRuntime",
  );
});
