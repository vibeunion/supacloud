import { expect, test } from "bun:test";
import {
  APPLICATION_DEVELOPMENT_LIMITS,
  APPLICATION_DEVELOPMENT_SCHEMA,
  ApplicationDevelopmentError,
  createApplicationDevelopmentContext,
  formatApplicationDevelopmentContext,
} from "./application-development";
import type { ApplicationGraph, CommandNode, ModuleNode } from "./types";

function command(name: string, overrides: Partial<CommandNode> = {}): CommandNode {
  return {
    className: name.split(".").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(""),
    name,
    transaction: "required",
    idempotency: "required",
    ...overrides,
  };
}

function module(name: string, overrides: Partial<ModuleNode> = {}): ModuleNode {
  return {
    name,
    className: `${name}Module`,
    file: `src/${name}.ts`,
    line: 1,
    imports: [],
    providers: [],
    controllers: [],
    commands: [],
    queries: [],
    exports: [],
    ...overrides,
  };
}

function graph(): ApplicationGraph {
  const orders = module("orders", {
    providers: [{ token: "OrdersService", tokenKind: "class", kind: "class", useClass: "OrdersService", scope: "application", deps: [], exported: false, file: "src/orders.ts", line: 1 }],
    commands: [command("orders.create", { permission: "orders.create", audit: "orders.created" })],
    jobs: [{ className: "CleanupJob", name: "orders.cleanup", serviceKey: "cleanupJob", scope: "job", mode: "task" }],
    controllers: [{
      className: "OrdersController", deps: [], scope: "application", file: "src/orders.ts", importPath: "src/orders",
      path: "/orders",
      routes: [{
        method: "POST", path: "/", handler: "create", command: "orders.create",
        schemaKinds: { body: "declared", response: "opaque" },
        aspects: [{ name: "AuditAspect", expression: "PRIVATE_ASPECT_EXPRESSION" }],
      }],
    }],
    resources: ["orders-db"],
  });
  return {
    modules: [orders],
    externalTokens: [],
    resources: [{ name: "orders-db", kind: "database", className: "OrdersDatabase", file: "src/resources.ts", line: 1, importPath: "src/resources" }],
    resourceUses: [
      { module: "orders", command: "orders.create", resource: "orders-db", resourceClass: "OrdersDatabase", operations: ["read", "write"] },
      { module: "orders", job: "orders.cleanup", resource: "orders-db", resourceClass: "OrdersDatabase", operations: ["consume"] },
    ],
    diagnostics: [{
      severity: "error", code: "invalid-command-mode", file: "src/orders.ts", line: 7,
      message: "PRIVATE_MESSAGE", suggestion: "PRIVATE_SUGGESTION",
      fix: { type: "set_command_mode", targetFile: "src/orders.ts", command: "CreateOrder", property: "transaction", expectedExpression: "PRIVATE_FIX_VALUE" },
    }],
  };
}

test("projects the current graph into the versioned development contract", () => {
  const context = createApplicationDevelopmentContext(graph());
  expect(context.schema).toBe(APPLICATION_DEVELOPMENT_SCHEMA);
  expect(context.source).toBe("current-graph");
  expect(context.deploymentVerified).toBe(false);

  expect(context.modules).toEqual([{
    name: "orders",
    className: "ordersModule",
    file: "src/orders.ts",
    providers: ["OrdersService"],
    controllers: ["OrdersController"],
    commands: ["orders.create"],
    jobs: ["orders.cleanup"],
    queries: [],
    resources: ["orders-db"],
  }]);
  expect(context.routes).toEqual([{
    module: "orders", method: "POST", path: "/", controller: "OrdersController", handler: "create",
    command: "orders.create", aspects: ["AuditAspect"], schemaKinds: { body: "declared", response: "opaque" },
  }]);
  expect(context.commands).toEqual([{
    module: "orders", name: "orders.create", permission: "orders.create",
    transaction: "required", idempotency: "required", audit: "orders.created",
    resources: [{ resource: "orders-db", operations: ["read", "write"] }],
  }]);
  expect(context.jobs).toEqual([{
    module: "orders", name: "orders.cleanup", mode: "task",
    resources: [{ resource: "orders-db", operations: ["consume"] }],
  }]);
  expect(context.resources).toEqual([{ name: "orders-db", kind: "database" }]);
  expect(context.resourceUses).toEqual([
    { module: "orders", owner: "orders.create", ownerKind: "command", resource: "orders-db", operations: ["read", "write"] },
    { module: "orders", owner: "orders.cleanup", ownerKind: "job", resource: "orders-db", operations: ["consume"] },
  ]);
  expect(context.executionPlans.some((plan) => plan.kind === "command" && plan.name === "orders.create")).toBe(true);
});

test("redacts diagnostic values, source expressions and aspect expressions", () => {
  const context = createApplicationDevelopmentContext(graph());
  expect(context.diagnostics).toEqual([{
    code: "invalid-command-mode", severity: "error", file: "src/orders.ts", line: 7,
    repair: { type: "set_command_mode", readiness: "input-required" },
  }]);
  const serialized = JSON.stringify(context);
  for (const secret of ["PRIVATE_MESSAGE", "PRIVATE_SUGGESTION", "PRIVATE_FIX_VALUE", "PRIVATE_ASPECT_EXPRESSION"]) {
    expect(serialized).not.toContain(secret);
  }
});

test("ordering is deterministic", () => {
  const source = graph();
  source.modules.push(module("audit"));
  const first = JSON.stringify(createApplicationDevelopmentContext(source));
  const second = JSON.stringify(createApplicationDevelopmentContext(source));
  expect(first).toBe(second);
  expect(createApplicationDevelopmentContext(source).modules.map((item) => item.name)).toEqual(["audit", "orders"]);
});

test("bounds large graphs and reports truncation", () => {
  const source: ApplicationGraph = {
    modules: Array.from({ length: APPLICATION_DEVELOPMENT_LIMITS.modules + 3 }, (_, index) => module(`module-${index}`)),
    externalTokens: [],
  };
  const context = createApplicationDevelopmentContext(source);
  expect(context.modules).toHaveLength(APPLICATION_DEVELOPMENT_LIMITS.modules);
  expect(context.omitted.modules).toBe(3);
});

test("fails closed when the projected document exceeds the public byte budget", () => {
  const source: ApplicationGraph = {
    modules: Array.from({ length: APPLICATION_DEVELOPMENT_LIMITS.modules }, (_, index) =>
      module(`module-${index}-${"x".repeat(2_000)}`)),
    externalTokens: [],
  };
  expect(() => createApplicationDevelopmentContext(source)).toThrow(ApplicationDevelopmentError);
});

test("formats a human-readable summary", () => {
  const text = formatApplicationDevelopmentContext(createApplicationDevelopmentContext(graph()));
  expect(text).toContain("APPLICATION supacloud.application-development.v1");
  expect(text).toContain("POST / -> OrdersController.create (orders)");
  expect(text).toContain("orders-db:database");
});