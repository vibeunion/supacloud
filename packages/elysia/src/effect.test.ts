import type { CompiledRouteRegistrar } from "./index";
import { expect, test } from "bun:test";
import { Context, Effect, Layer } from "effect";
import { Elysia } from "elysia";
import {
  FeatureAdapterError, FeatureContextError, FeatureEntityError, FeatureOperationError,
} from "@supacloud/app";
import { ApplicationError, createApplication, createModulePlugin } from "./index";
import { createDefaultEffectRuntime, createEffectRuntimeFromLayer, runCompiledEffect } from "./effect";
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

test("uses bounded instance code, message and status only when the mapping opts in", async () => {
  await expect(runCompiledEffect(
    Effect.fail({
      _tag: "FA_ROUTE_FAILURE",
      code: "FA_SAVED_LIST_VIEW_NOT_FOUND",
      message: "保存视图不存在或已删除。",
      status: 404,
    }),
    {
      required: true,
      errors: [{
        tag: "FA_ROUTE_FAILURE",
        status: 500,
        code: "FA_ROUTE_FAILURE",
        codeFromError: true,
        messageFromError: true,
        statusFromError: true,
      }],
    },
  )).rejects.toMatchObject({
    status: 404,
    code: "FA_SAVED_LIST_VIEW_NOT_FOUND",
    message: "保存视图不存在或已删除。",
  });
});

test("preserves public details from a mapped Effect failure", async () => {
  await expect(runCompiledEffect(
    Effect.fail({
      _tag: "IntegrationNotConfigured",
      code: "INTEGRATION_NOT_CONFIGURED",
      message: "Integration is not configured",
      status: 503,
      details: { integration: "pdf_export", status: "not_configured" },
    }),
    {
      required: true,
      errors: [{
        tag: "IntegrationNotConfigured",
        status: 503,
        code: "INTEGRATION_NOT_CONFIGURED",
        codeFromError: true,
        messageFromError: true,
        statusFromError: true,
      }],
    },
  )).rejects.toMatchObject({
    status: 503,
    code: "INTEGRATION_NOT_CONFIGURED",
    details: { integration: "pdf_export", status: "not_configured" },
  });
});

test("ignores out-of-range instance statuses", async () => {
  await expect(runCompiledEffect(
    Effect.fail({ _tag: "FA_ROUTE_FAILURE", code: "X", message: "x", status: 200 }),
    {
      required: true,
      errors: [{
        tag: "FA_ROUTE_FAILURE",
        status: 500,
        code: "FA_ROUTE_FAILURE",
        statusFromError: true,
      }],
    },
  )).rejects.toMatchObject({ status: 500, code: "FA_ROUTE_FAILURE" });
});

test("keeps the declared mapping when instance values are not opted in", async () => {
  await expect(runCompiledEffect(
    Effect.fail({ _tag: "OrderNotFound", code: "RAW_CODE", message: "raw message" }),
    {
      required: true,
      errors: [{ tag: "OrderNotFound", status: 404, code: "ORDER_NOT_FOUND", message: "Not found." }],
    },
  )).rejects.toMatchObject({
    status: 404,
    code: "ORDER_NOT_FOUND",
    message: "Not found.",
  });
});

test("does not publish an instance code as the message unless messageFromError is set", async () => {
  await expect(runCompiledEffect(
    Effect.fail({ _tag: "OrderNotFound", code: "RAW_CODE", message: "raw message" }),
    {
      required: true,
      errors: [{ tag: "OrderNotFound", status: 404, code: "ORDER_NOT_FOUND", codeFromError: true }],
    },
  )).rejects.toMatchObject({
    status: 404,
    code: "RAW_CODE",
    message: "ORDER_NOT_FOUND",
  });
});

test("maps framework Feature operation errors through the declared route contract", async () => {
  await expect(runCompiledEffect(
    Effect.fail(new FeatureOperationError()),
    {
      required: true,
      errors: [{
        tag: "FEATURE_OPERATION_RESULT_MISMATCH",
        status: 503,
        code: "FEATURE_OPERATION_RESULT_MISMATCH",
      }],
    },
  )).rejects.toMatchObject({
    status: 503,
    code: "FEATURE_OPERATION_RESULT_MISMATCH",
    expose: true,
  });
});

test("maps framework Feature setup errors through the declared route contract", async () => {
  for (const error of [
    new FeatureContextError(),
    new FeatureAdapterError("case-approval.reader"),
    new FeatureEntityError(),
  ]) {
    await expect(runCompiledEffect(
      Effect.fail(error),
      {
        required: true,
        errors: [
          { tag: "FEATURE_CONTEXT_REQUIRED", status: 500, code: "FEATURE_CONTEXT_REQUIRED" },
          { tag: "FEATURE_ADAPTER_UNAVAILABLE", status: 503, code: "FEATURE_ADAPTER_UNAVAILABLE" },
          { tag: "FEATURE_ENTITY_RESULT_MISMATCH", status: 503, code: "FEATURE_ENTITY_RESULT_MISMATCH" },
        ],
      },
    )).rejects.toMatchObject({
      status: error instanceof FeatureContextError ? 500 : 503,
      code: error._tag,
      expose: true,
    });
  }
});

test("maps defect failures from the Effect 4 exit cause", async () => {
  const applicationError = new ApplicationError("Review state or version changed", {
    status: 409,
    code: "REVIEW_CONFLICT",
  });
  await expect(runCompiledEffect(
    Effect.die(applicationError),
    {
      required: true,
      errors: [{ tag: "REVIEW_CONFLICT", status: 409, code: "REVIEW_CONFLICT" }],
    },
  )).rejects.toMatchObject({
    status: 409,
    code: "REVIEW_CONFLICT",
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

test("retries only a declared transient 5xx failure", async () => {
  let attempts = 0;
  const program = Effect.suspend(() => {
    attempts += 1;
    return attempts < 3
      ? Effect.fail({ _tag: "UpstreamUnavailable" })
      : Effect.succeed("ok");
  });
  await expect(runCompiledEffect(
    program,
    {
      required: true,
      retry: "explicit",
      maxAttempts: 3,
      errors: [{ tag: "UpstreamUnavailable", status: 503, code: "UPSTREAM_UNAVAILABLE", retryable: true }],
    },
    createDefaultEffectRuntime(),
  )).resolves.toBe("ok");
  expect(attempts).toBe(3);
});

test("does not retry when the descriptor omits the retry policy", async () => {
  let attempts = 0;
  const program = Effect.suspend(() => {
    attempts += 1;
    return Effect.fail({ _tag: "UpstreamUnavailable" });
  });
  await expect(runCompiledEffect(
    program,
    {
      required: true,
      errors: [{ tag: "UpstreamUnavailable", status: 503, code: "UPSTREAM_UNAVAILABLE", retryable: true }],
    },
    createDefaultEffectRuntime(),
  )).rejects.toMatchObject({ status: 503, code: "UPSTREAM_UNAVAILABLE" });
  expect(attempts).toBe(1);
});

test("does not retry client, outcome-unknown or unlisted failures", async () => {
  for (const descriptor of [
    { required: true as const, retry: "explicit" as const, maxAttempts: 3, errors: [{ tag: "OrderNotFound", status: 404, code: "ORDER_NOT_FOUND", retryable: true }] },
    { required: true as const, retry: "explicit" as const, maxAttempts: 3, errors: [{ tag: "OutcomeUnknown", status: 503, code: "OUTCOME_UNKNOWN", retryable: true, outcomeUnknown: true }] },
    { required: true as const, retry: "explicit" as const, maxAttempts: 3, errors: [{ tag: "UpstreamUnavailable", status: 503, code: "UPSTREAM_UNAVAILABLE" }] },
  ]) {
    let attempts = 0;
    const tag = descriptor.errors[0]!.tag;
    const program = Effect.suspend(() => {
      attempts += 1;
      return Effect.fail({ _tag: tag });
    });
    await expect(runCompiledEffect(program, descriptor)).rejects.toBeTruthy();
    expect(attempts).toBe(1);
  }
});

test("reuses Layer services and disposes them explicitly", async () => {
  const Counter = Context.Service<{ readonly value: number }>("Counter");
  let builds = 0;
  let releases = 0;
  const layer = Layer.effect(
    Counter,
    Effect.acquireRelease(
      Effect.sync(() => {
        builds += 1;
        return { value: builds };
      }),
      () => Effect.sync(() => {
        releases += 1;
      }),
    ),
  );
  const runtime = createEffectRuntimeFromLayer(layer);
  const program = Effect.gen(function* () {
    const counter = yield* Counter;
    return counter.value;
  });

  await expect(runCompiledEffect(program, { required: true }, runtime)).resolves.toBe(1);
  await expect(runCompiledEffect(program, { required: true }, runtime)).resolves.toBe(1);
  expect(builds).toBe(1);
  expect(releases).toBe(0);
  await runtime.dispose?.();
  expect(releases).toBe(1);
});

test("disposes the Effect runtime with the application lifecycle", async () => {
  let disposed = 0;
  const effectRuntime = createDefaultEffectRuntime();
  effectRuntime.dispose = async () => {
    disposed += 1;
  };
  const app = createApplication({
    modules: [],
    effectRuntime,
  });

  await app.destroy();
  expect(disposed).toBe(1);
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
    registerRoutes(register: CompiledRouteRegistrar) {
      register(this.controllers[0]!, this.controllers[0]!.routes[0]!, "/orders");
      register(this.controllers[0]!, this.controllers[0]!.routes[1]!, "/orders/missing");
    },
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
    registerRoutes(register: CompiledRouteRegistrar) {
      register(this.controllers[0]!, this.controllers[0]!.routes[0]!, "/orders");
    },
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
