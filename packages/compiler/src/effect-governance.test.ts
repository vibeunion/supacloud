import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApplicationGraph } from "./types";
import { validateEffectPolicies } from "./effect-governance";
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
  ]);
});

test("accepts a complete retryable idempotent Effect contract", () => {
  expect(validateEffectPolicies(graphWith({
    required: true,
    dependencies: ["OrderRepository"],
    errors: [{ tag: "OrderNotFound", status: 404, code: "ORDER_NOT_FOUND" }],
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
  const { root, graph } = await analyzeStrictEffectFixture(`import * as EffectRuntime from "effect/Effect";
import { Controller, Get, Module } from "./runtime";
import type { Effect } from "./effect";

@Controller("/orders")
class OrdersController {
  @Get("/", { effect: { required: true, dependencies: [], errors: [], retry: "none" } })
  list(): Effect<string, never, never> {
    EffectRuntime.runPromise({} as never);
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
