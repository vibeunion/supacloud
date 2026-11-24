import { describe, expect, test } from "bun:test";
import { createInferencePlan } from "./inference";
import type { ApplicationGraph } from "./types";

function graph(): ApplicationGraph {
  return {
    externalTokens: [],
    modules: [
      {
        name: "orders",
        className: "OrdersModule",
        file: "src/orders/orders.module.ts",
        line: 1,
        imports: [],
        providers: [],
        controllers: [{
          className: "OrdersController",
          path: "/orders",
          scope: "application",
          deps: [],
          file: "src/orders/orders.controller.ts",
          importPath: "src/orders/orders.controller",
          routes: [{
            method: "GET",
            path: "/:id",
            pathParams: ["id"],
            handler: "find",
            handlerParams: [{ name: "id", kind: "unknown" }],
          }, {
            method: "POST",
            path: "/",
            handler: "create",
            handlerParams: [],
          }],
        }],
        commands: [{
          className: "CreateOrder",
          name: "orders.create",
          transaction: "required",
          idempotency: "required",
        }],
        queries: [],
        exports: [],
      },
    ],
  };
}

describe("inference plan", () => {
  test("infers a unique root module and safe route parameter fixes", () => {
    const plan = createInferencePlan(graph(), {
      rootDir: "/project",
      sourceDir: "/project/src",
      generatedDir: "/project/generated",
    });
    expect(plan.rootModule).toBe("orders");
    expect(plan.items).toContainEqual(expect.objectContaining({
      field: "application.rootModule",
      readiness: "safe",
      value: "orders",
    }));
    expect(plan.items).toContainEqual(expect.objectContaining({
      field: "route.parameterBinding",
      readiness: "safe",
      fix: expect.objectContaining({ type: "add_route_parameter_binding", binding: "param" }),
    }));
  });

  test("never infers business permissions or write boundaries", () => {
    const plan = createInferencePlan(graph());
    expect(plan.items).toContainEqual(expect.objectContaining({
      field: "command.permission",
      readiness: "never",
    }));
    expect(plan.items).toContainEqual(expect.objectContaining({
      field: "route.writeBoundary",
      readiness: "never",
    }));
    expect(plan.explicitInputs).toContain("tenant and RLS policy");
  });

  test("reports ambiguous roots instead of choosing by import order", () => {
    const source = graph();
    const plan = createInferencePlan({
      ...source,
      modules: source.modules.concat({
        ...source.modules[0]!,
        name: "billing",
        className: "BillingModule",
        file: "src/billing/billing.module.ts",
      }),
    });
    expect(plan.rootModule).toBeUndefined();
    expect(plan.rootModuleCandidates).toEqual(["billing", "orders"]);
    expect(plan.items).toContainEqual(expect.objectContaining({
      field: "application.rootModule",
      readiness: "confirm",
    }));
  });

  test("suggests a missing module import only when one module exports the token", () => {
    const source = graph();
    const orders = source.modules[0]!;
    const plan = createInferencePlan({
      ...source,
      modules: [
        {
          ...orders,
          exports: ["CaseRepository"],
          providers: [{ ...orders.providers[0]!, token: "CaseRepository", deps: [] }],
        },
        {
          ...orders,
          name: "cases",
          className: "CasesModule",
          file: "src/cases/cases.module.ts",
          imports: [],
          exports: [],
          providers: [{ ...orders.providers[0]!, token: "ApproveCase", deps: ["CaseRepository"] }],
        },
      ],
    });
    const dependency = plan.items.find((item) => item.field === "module.imports");
    expect(dependency).toMatchObject({
      readiness: "confirm",
      value: { module: "cases", imports: "orders", token: "CaseRepository" },
      fix: {
        type: "add_module_import",
        targetFile: "src/cases/cases.module.ts",
        module: "orders",
        symbol: "OrdersModule",
        targetModule: "cases",
        importPath: "../orders/orders.module",
      },
    });
  });

  test("keeps table operation ownership explicit and links the ownership commands", () => {
    const plan = createInferencePlan(graph());
    expect(plan.items).toContainEqual(expect.objectContaining({
      field: "database.operationOwnership",
      readiness: "never",
      action: "manual",
    }));
    expect(plan.explicitInputs).toContain("table operation ownership in db/modules.ts");
    expect(plan.commands.ownershipSuggest).toBe("supacloud db operation-ownership suggest");
    expect(plan.commands.ownershipAdopt).toBe("supacloud db operation-ownership adopt");
    expect(plan.next).toContain("supacloud db operation-ownership suggest");
  });
});
