import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApplicationGraph } from "./types";
import { validateEffectPolicies, validateJobPolicies } from "./effect-governance";
import { analyzeProject } from "./analyze";
import { compileOptionsFromConfig } from "./config";
import { compileProject } from "./compile";
import { writeFixtureProject } from "./fixtures/helpers";
import { FIXTURE_TSCONFIG, RUNTIME_SOURCE } from "./fixtures/runtime-source";

function graphWith(effect: ApplicationGraph["modules"][number]["controllers"][number]["routes"][number]["effect"], command?: {
  className: string;
  name: string;
  transaction: "required" | "none";
  idempotency: "required" | "none";
}): ApplicationGraph {
  return {
    modules: [{
      name: "orders",
      className: "OrdersModule",
      file: "orders.module.ts",
      line: 1,
      imports: [],
      providers: [],
      controllers: [{
        className: "OrdersController",
        path: "/orders",
        scope: "request",
        deps: [],
        file: "orders.controller.ts",
        importPath: "orders.controller",
        routes: [{
          method: "POST",
          path: "/:id",
          handler: "save",
          command: command?.className,
          effect,
        }],
      }],
      commands: command ? [command] : [],
      jobs: [],
      queries: [],
      exports: [],
    }],
    externalTokens: [],
  };
}

test("requires explicit Effect route contracts when enabled", () => {
  const diagnostics = validateEffectPolicies(graphWith(undefined), {
    requireRouteEffects: true,
    requireErrorMappings: true,
    requireDependencies: true,
  });
  expect(diagnostics).toContainEqual(expect.objectContaining({
    code: "effect-contract-required",
    errorCode: "SC3036",
  }));
});

test("requires mappings and dependencies and blocks retry on non-idempotent commands", () => {
  const diagnostics = validateEffectPolicies(graphWith({
    required: true,
    retry: "explicit",
    maxAttempts: 2,
  }, {
    className: "SaveOrderCommand",
    name: "orders.save",
    transaction: "required",
    idempotency: "none",
  }), {
    requireErrorMappings: true,
    requireDependencies: true,
  });
  expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
    "effect-error-mapping-required",
    "effect-dependencies-required",
    "effect-command-retry-forbidden",
    "effect-retry-target-required",
  ]);
});

test("accepts a complete retryable idempotent Effect contract", () => {
  expect(validateEffectPolicies(graphWith({
    required: true,
    dependencies: ["OrderRepository"],
    errors: [
      { tag: "OrderNotFound", status: 404, code: "ORDER_NOT_FOUND" },
      { tag: "OrderUpstreamUnavailable", status: 503, code: "ORDER_UPSTREAM_UNAVAILABLE", retryable: true },
    ],
    retry: "explicit",
    maxAttempts: 3,
    timeoutMs: 1000,
  }, {
    className: "SaveOrderCommand",
    name: "orders.save",
    transaction: "required",
    idempotency: "required",
  }), {
    requireErrorMappings: true,
    requireDependencies: true,
})).toEqual([]);
});

test("accepts explicitly empty Effect mappings and dependencies", () => {
  expect(validateEffectPolicies(graphWith({
    required: true,
    dependencies: [],
    errors: [],
    retry: "none",
  }), {
    requireRouteEffects: true,
    requireErrorMappings: true,
    requireDependencies: true,
})).toEqual([]);
});

test("zero-config compilation enables strict Effect governance", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-effect-default-"));
  try {
    await writeFixtureProject(root, {
      "tsconfig.json": FIXTURE_TSCONFIG,
      "src/runtime.ts": RUNTIME_SOURCE,
      "src/orders.module.ts": `import { Controller, Get, Module } from "./runtime";

@Controller("/orders")
class OrdersController {
  @Get("/")
  list(): { ok: true } {
    return { ok: true };
  }
}

@Module({ name: "orders", controllers: [OrdersController] })
export class OrdersModule {}
`,
    });
    const result = await compileProject({
      ...compileOptionsFromConfig({}, root),
      outDir: join(root, "generated"),
    });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "effect-contract-required",
      errorCode: "SC3036",
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("analyzes and preserves a route Effect contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-effect-contract-"));
  try {
    await writeFixtureProject(root, {
      "tsconfig.json": FIXTURE_TSCONFIG,
      "src/runtime.ts": RUNTIME_SOURCE,
      "src/effect.ts": "export type Effect<A, E, R> = { readonly _effect: [A, E, R] };\n",
      "src/orders.module.ts": `import { Controller, Get, Module } from "./runtime";
import type { Effect } from "./effect";

@Controller("/orders")
class OrdersController {
  @Get("/", {
    effect: {
      required: true,
      dependencies: ["OrderApi"],
      errors: [{ tag: "OrderNotFound", status: 404, code: "ORDER_NOT_FOUND" }],
      retry: "none",
      timeoutMs: 1000,
    },
  })
  list(): Effect<string, { _tag: "OrderNotFound" }, "OrderApi"> {
    return {} as Effect<string, { _tag: "OrderNotFound" }, "OrderApi">;
  }
}

@Module({ name: "orders", controllers: [OrdersController] })
export class OrdersModule {}
`,
    });
    const graph = await analyzeProject(root);
    const route = graph.modules[0]?.controllers[0]?.routes[0];
    expect(route?.effect).toEqual({
      required: true,
    dependencies: ["OrderApi"],
    errors: [{ tag: "OrderNotFound", status: 404, code: "ORDER_NOT_FOUND" }],
    retry: "none",
    timeoutMs: 1000,
    });
    expect(graph.diagnostics ?? []).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function analyzeStrictEffectFixture(source: string, effectSource = "export type Effect<A, E, R> = { readonly _effect: [A, E, R] };\n") {
  const root = await mkdtemp(join(tmpdir(), "supacloud-effect-strict-"));
  await writeFixtureProject(root, {
    "tsconfig.json": FIXTURE_TSCONFIG,
    "src/runtime.ts": RUNTIME_SOURCE,
    "src/effect.ts": effectSource,
    "src/orders.module.ts": source,
  });
  return { root, graph: await analyzeProject(root) };
}

test("rejects unknown Effect failures", async () => {
  const { root, graph } = await analyzeStrictEffectFixture(`import { Controller, Get, Module } from "./runtime";
import type { Effect } from "./effect";

@Controller("/orders")
class OrdersController {
  @Get("/", { effect: { required: true, dependencies: [], errors: [], retry: "none" } })
  list(): Effect<string, unknown, never> {
    return {} as Effect<string, unknown, never>;
  }
}

@Module({ name: "orders", controllers: [OrdersController] })
export class OrdersModule {}
`);
  try {
    expect(graph.diagnostics).toContainEqual(expect.objectContaining({
      code: "effect-error-type",
      errorCode: "SC3041",
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires exact failure mappings and dependency types", async () => {
  const { root, graph } = await analyzeStrictEffectFixture(`import { Controller, Get, Module } from "./runtime";
import type { Effect } from "./effect";

type OrderFailure = { _tag: "OrderNotFound" } | { _tag: "OrderConflict" };

@Controller("/orders")
class OrdersController {
  @Get("/", {
    effect: {
      required: true,
      dependencies: ["OrderApi"],
      errors: [{ tag: "OrderNotFound", status: 404, code: "ORDER_NOT_FOUND" }],
      retry: "none",
      timeoutMs: 1000,
    },
  })
  list(): Effect<string, OrderFailure, "OtherApi"> {
    return {} as Effect<string, OrderFailure, "OtherApi">;
  }
}

@Module({ name: "orders", controllers: [OrdersController] })
export class OrdersModule {}
`);
  try {
    expect(graph.diagnostics).toContainEqual(expect.objectContaining({
      code: "effect-error-mapping-type",
      errorCode: "SC3042",
    }));
    expect(graph.diagnostics).toContainEqual(expect.objectContaining({
      code: "effect-dependency-mismatch",
      errorCode: "SC3043",
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires timeouts for Effect environments", async () => {
  const { root, graph } = await analyzeStrictEffectFixture(`import { Controller, Get, Module } from "./runtime";
import type { Effect } from "./effect";

@Controller("/orders")
class OrdersController {
  @Get("/", {
    effect: {
      required: true,
      dependencies: ["OrderApi"],
      errors: [],
      retry: "none",
    },
  })
  list(): Effect<string, never, "OrderApi"> {
    return {} as Effect<string, never, "OrderApi">;
  }
}

@Module({ name: "orders", controllers: [OrdersController] })
export class OrdersModule {}
`);
  try {
    expect(graph.diagnostics).toContainEqual(expect.objectContaining({
      code: "effect-timeout-required",
      errorCode: "SC3044",
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects direct throws and Effect interpretation in governed handlers", async () => {
  const { root, graph } = await analyzeStrictEffectFixture(`import { Effect, Runtime as EffectRuntime } from "effect";
import { Controller, Get, Module } from "./runtime";
import type { Effect as RouteEffect } from "./effect";

@Controller("/orders")
class OrdersController {
  @Get("/", { effect: { required: true, dependencies: [], errors: [], retry: "none" } })
  list(): RouteEffect<string, never, never> {
    Effect.runPromise({} as never);
    EffectRuntime.runSync({} as never);
    throw new Error("no");
  }
}

@Module({ name: "orders", controllers: [OrdersController] })
export class OrdersModule {}
`);
  try {
    expect(graph.diagnostics).toContainEqual(expect.objectContaining({
      code: "effect-direct-runtime-execution",
      errorCode: "SC3045",
    }));
    expect(graph.diagnostics).toContainEqual(expect.objectContaining({
      code: "effect-direct-throw",
      errorCode: "SC3046",
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allows Effect interpretation in test sources", async () => {
  const { root } = await analyzeStrictEffectFixture(`import { Controller, Get, Module } from "./runtime";
import type { Effect } from "./effect";

@Controller("/orders")
class OrdersController {
  @Get("/", { effect: { required: true, dependencies: [], errors: [], retry: "none" } })
  list(): Effect<string, never, never> {
    return {} as Effect<string, never, never>;
  }
}

@Module({ name: "orders", controllers: [OrdersController] })
export class OrdersModule {}
`);
  try {
    await writeFixtureProject(root, {
      "src/orders.controller.test.ts": `import * as EffectRuntime from "effect/Effect";
EffectRuntime.runPromise({} as never);
`,
    });
    const graph = await analyzeProject(root);
    expect(graph.diagnostics ?? []).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects Promise route returns under an Effect contract", async () => {
  const { root, graph } = await analyzeStrictEffectFixture(`import { Controller, Get, Module } from "./runtime";

@Controller("/orders")
class OrdersController {
  @Get("/", { effect: { required: true, dependencies: [], errors: [], retry: "none" } })
  list(): Promise<string> {
    return Promise.resolve("ok");
  }
}

@Module({ name: "orders", controllers: [OrdersController] })
export class OrdersModule {}
`);
  try {
    expect(graph.diagnostics).toContainEqual(expect.objectContaining({
      code: "effect-promise-return",
      errorCode: "SC3047",
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires an explicit retry policy on every Effect contract by default", () => {
  const diagnostics = validateEffectPolicies(graphWith({
    required: true,
    dependencies: [],
    errors: [{ tag: "OrderNotFound", status: 404, code: "ORDER_NOT_FOUND" }],
  }), {
    requireErrorMappings: true,
    requireDependencies: true,
  });
  expect(diagnostics).toContainEqual(expect.objectContaining({
    code: "effect-retry-required",
    errorCode: "SC3050",
    docsUrl: "https://supacloud.dev/errors/SC3050",
    suggestion: 'Set effect.retry to "none". That is the required default; use "explicit" only with maxAttempts and a retryable 5xx allow-list.',
  }));
});

test("allows an omitted retry policy when the requirement is disabled", () => {
  const diagnostics = validateEffectPolicies(graphWith({
    required: true,
    dependencies: [],
    errors: [],
  }), {
    requireErrorMappings: true,
    requireDependencies: true,
    requireRetryPolicy: false,
  });
  expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([]);
});

test("materializes an omitted retry policy as none when the requirement is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-effect-default-retry-"));
  try {
    await writeFixtureProject(root, {
      "tsconfig.json": FIXTURE_TSCONFIG,
      "src/runtime.ts": RUNTIME_SOURCE,
      "src/effect.ts": "export type Effect<A, E, R> = { readonly _effect: [A, E, R] };\n",
      "src/orders.module.ts": `import { Controller, Get, Module } from "./runtime";
import type { Effect } from "./effect";

@Controller("/orders")
class OrdersController {
  @Get("/", {
    effect: {
      required: true,
      dependencies: [],
      errors: [],
    },
  })
  list(): Effect<string, never, never> {
    return {} as Effect<string, never, never>;
  }
}

@Module({ name: "orders", controllers: [OrdersController] })
export class OrdersModule {}
`,
    });
    const graph = await analyzeProject(root, undefined, undefined, undefined, {
      requireRetryPolicy: false,
    });
    expect(graph.modules[0]?.controllers[0]?.routes[0]?.effect).toEqual({
      required: true,
      dependencies: [],
      errors: [],
      retry: "none",
    });
    expect(graph.diagnostics ?? []).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects explicit retry without a transient allow-list", () => {
  const diagnostics = validateEffectPolicies(graphWith({
    required: true,
    dependencies: [],
    errors: [{ tag: "OrderNotFound", status: 404, code: "ORDER_NOT_FOUND" }],
    retry: "explicit",
    maxAttempts: 2,
  }), {
    requireErrorMappings: true,
    requireDependencies: true,
  });
  expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["effect-retry-target-required"]);
});

test("rejects retryable failures that are not transient 5xx", () => {
  const diagnostics = validateEffectPolicies(graphWith({
    required: true,
    dependencies: [],
    errors: [
      { tag: "OrderNotFound", status: 404, code: "ORDER_NOT_FOUND", retryable: true },
      { tag: "OutcomeUnknown", status: 503, code: "OUTCOME_UNKNOWN", retryable: true, outcomeUnknown: true },
    ],
    retry: "explicit",
    maxAttempts: 2,
  }));
  expect(diagnostics.map((diagnostic) => diagnostic.errorCode)).toEqual(["SC3049", "SC3049"]);
});

test("accepts an explicit retry limited to one transient 5xx failure", async () => {
  const { root, graph } = await analyzeStrictEffectFixture(`import { Controller, Post, Module } from "./runtime";
import type { Effect } from "./effect";

type Failure = { _tag: "OrderNotFound" } | { _tag: "UpstreamUnavailable" };

@Controller("/orders")
class OrdersController {
  @Post("/", {
    effect: {
      required: true,
      dependencies: [],
      errors: [
        { tag: "OrderNotFound", status: 404, code: "ORDER_NOT_FOUND" },
        { tag: "UpstreamUnavailable", status: 503, code: "UPSTREAM_UNAVAILABLE", retryable: true },
      ],
      retry: "explicit",
      maxAttempts: 2,
    },
  })
  save(): Effect<string, Failure, never> {
    return {} as Effect<string, Failure, never>;
  }
}

@Module({ name: "orders", controllers: [OrdersController] })
export class OrdersModule {}
`);
  try {
    expect(graph.diagnostics ?? []).toEqual([]);
    expect(graph.modules[0]?.controllers[0]?.routes[0]?.effect?.errors?.[1]).toMatchObject({
      retryable: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects retrying jobs without an idempotency contract", () => {
  const graph = graphWith(undefined);
  graph.modules[0]!.jobs = [{
    className: "RebuildJob",
    name: "orders.rebuild",
    serviceKey: "rebuildJob",
    scope: "job",
    maxAttempts: 2,
    idempotency: "none",
  }];
  expect(validateJobPolicies(graph)).toContainEqual(expect.objectContaining({
    code: "job-retry-idempotency-required",
    errorCode: "SC4027",
  }));
  graph.modules[0]!.jobs[0]!.idempotency = "required";
  expect(validateJobPolicies(graph)).toEqual([]);
});

test("preserves opt-in instance code and message mappings", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-effect-instance-values-"));
  try {
    await writeFixtureProject(root, {
      "tsconfig.json": FIXTURE_TSCONFIG,
      "src/runtime.ts": RUNTIME_SOURCE,
      "src/effect.ts": "export type Effect<A, E, R> = { readonly _effect: [A, E, R] };\n",
      "src/orders.module.ts": `import { Controller, Get, Module } from "./runtime";
import type { Effect } from "./effect";

type ServiceRoleRequired = {
  readonly _tag: "FA_SERVICE_ROLE_REQUIRED";
  readonly code: string;
  readonly message: string;
};

@Controller("/orders")
class OrdersController {
  @Get("/", {
    effect: {
      required: true,
      dependencies: [],
      errors: [{
        tag: "FA_SERVICE_ROLE_REQUIRED",
        status: 503,
        code: "FA_SERVICE_ROLE_REQUIRED",
        codeFromError: true,
        messageFromError: true,
        statusFromError: true,
      }],
      retry: "none",
    },
  })
  list(): Effect<string, ServiceRoleRequired, never> {
    return {} as Effect<string, ServiceRoleRequired, never>;
  }
}

@Module({ name: "orders", controllers: [OrdersController] })
export class OrdersModule {}
`,
    });
    const graph = await analyzeProject(root);
    expect(graph.modules[0]?.controllers[0]?.routes[0]?.effect).toEqual({
      required: true,
      dependencies: [],
      errors: [{
        tag: "FA_SERVICE_ROLE_REQUIRED",
        status: 503,
        code: "FA_SERVICE_ROLE_REQUIRED",
        codeFromError: true,
        messageFromError: true,
        statusFromError: true,
      }],
      retry: "none",
    });
    expect(graph.diagnostics ?? []).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects non-literal Effect instance flags", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-effect-instance-flag-"));
  try {
    await writeFixtureProject(root, {
      "tsconfig.json": FIXTURE_TSCONFIG,
      "src/runtime.ts": RUNTIME_SOURCE,
      "src/effect.ts": "export type Effect<A, E, R> = { readonly _effect: [A, E, R] };\n",
      "src/orders.module.ts": `import { Controller, Get, Module } from "./runtime";
import type { Effect } from "./effect";

const useInstanceCode = true;

@Controller("/orders")
class OrdersController {
  @Get("/", {
    effect: {
      required: true,
      dependencies: [],
      errors: [{ tag: "OrderNotFound", status: 404, code: "ORDER_NOT_FOUND", codeFromError: useInstanceCode }],
      retry: "none",
    },
  })
  list(): Effect<string, { _tag: "OrderNotFound" }, never> {
    return {} as Effect<string, { _tag: "OrderNotFound" }, never>;
  }
}

@Module({ name: "orders", controllers: [OrdersController] })
export class OrdersModule {}
`,
    });
    const graph = await analyzeProject(root);
    expect(graph.diagnostics).toContainEqual(expect.objectContaining({
      code: "invalid-effect-errors",
      errorCode: "SC3034",
      message: expect.stringContaining("boolean literals"),
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
async function analyzeSharedEffectDeclarationsFixture(source: string, declarations: string) {
  const root = await mkdtemp(join(tmpdir(), "supacloud-effect-shared-"));
  await writeFixtureProject(root, {
    "tsconfig.json": FIXTURE_TSCONFIG,
    "src/runtime.ts": RUNTIME_SOURCE,
    "src/effect.ts": "export type Effect<A, E, R> = { readonly _effect: [A, E, R] };\n",
    "src/order-declarations.ts": declarations,
    "src/orders.module.ts": source,
  });
  return { root, graph: await analyzeProject(root) };
}

test("resolves shared const declarations for Effect dependencies and error mappings", async () => {
  const { root, graph } = await analyzeSharedEffectDeclarationsFixture(
    `import { Controller, Get, Module } from "./runtime";
import type { Effect } from "./effect";
import { ORDER_DEPENDENCIES, ORDER_ERRORS } from "./order-declarations";

@Controller("/orders")
class OrdersController {
  @Get("/", { effect: { required: true, dependencies: ORDER_DEPENDENCIES, errors: ORDER_ERRORS, retry: "none", timeoutMs: 1000 } })
  list(): Effect<string, { _tag: "OrderNotFound" }, "OrderApi"> {
    return {} as Effect<string, { _tag: "OrderNotFound" }, "OrderApi">;
  }
}

@Module({ name: "orders", controllers: [OrdersController] })
export class OrdersModule {}
`,
    `export const ORDER_DEPENDENCIES = ["OrderApi"] as const;
export const ORDER_ERRORS = [{ tag: "OrderNotFound", status: 404, code: "ORDER_NOT_FOUND" }] as const;
`,
  );
  try {
    const route = graph.modules[0]?.controllers[0]?.routes[0];
    expect(route?.effect).toEqual({
      required: true,
      dependencies: ["OrderApi"],
      errors: [{ tag: "OrderNotFound", status: 404, code: "ORDER_NOT_FOUND" }],
      retry: "none",
      timeoutMs: 1000,
    });
    expect(graph.diagnostics ?? []).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects shared Effect declarations whose entries are not literal", async () => {
  const { root, graph } = await analyzeSharedEffectDeclarationsFixture(
    `import { Controller, Get, Module } from "./runtime";
import type { Effect } from "./effect";
import { ORDER_ERRORS } from "./order-declarations";

@Controller("/orders")
class OrdersController {
  @Get("/", { effect: { required: true, dependencies: [], errors: ORDER_ERRORS, retry: "none" } })
  list(): Effect<string, { _tag: "OrderNotFound" }, never> {
    return {} as Effect<string, { _tag: "OrderNotFound" }, never>;
  }
}

@Module({ name: "orders", controllers: [OrdersController] })
export class OrdersModule {}
`,
    `const orderNotFoundTag = "OrderNotFound";
export const ORDER_ERRORS = [{ tag: orderNotFoundTag, status: 404, code: "ORDER_NOT_FOUND" }];
`,
  );
  try {
    expect(graph.diagnostics).toContainEqual(expect.objectContaining({
      code: "invalid-effect-errors",
      errorCode: "SC3034",
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects mutable shared Effect declarations", async () => {
  const { root, graph } = await analyzeSharedEffectDeclarationsFixture(
    `import { Controller, Get, Module } from "./runtime";
import type { Effect } from "./effect";
import { ORDER_ERRORS } from "./order-declarations";

@Controller("/orders")
class OrdersController {
  @Get("/", { effect: { required: true, dependencies: [], errors: ORDER_ERRORS, retry: "none" } })
  list(): Effect<string, { _tag: "OrderNotFound" }, never> {
    return {} as Effect<string, { _tag: "OrderNotFound" }, never>;
  }
}

@Module({ name: "orders", controllers: [OrdersController] })
export class OrdersModule {}
`,
    `export let ORDER_ERRORS = [{ tag: "OrderNotFound", status: 404, code: "ORDER_NOT_FOUND" }];
`,
  );
  try {
    expect(graph.diagnostics).toContainEqual(expect.objectContaining({
      code: "invalid-effect-errors",
      errorCode: "SC3034",
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
