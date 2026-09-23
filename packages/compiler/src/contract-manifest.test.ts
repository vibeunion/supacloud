import { expect, test } from "bun:test";
import { buildContractManifest } from "./contract-manifest";
import type { ApplicationGraph } from "./types";

test("contract manifest preserves status-aware response schemas without removing legacy fields", () => {
  const graph: ApplicationGraph = {
    externalTokens: [],
    modules: [{
      name: "orders",
      className: "OrdersModule",
      file: "src/orders.module.ts",
      line: 1,
      imports: [],
      providers: [],
      commands: [],
      queries: [],
      exports: [],
      controllers: [{
        className: "OrdersController",
        path: "/orders",
        scope: "request",
        deps: [],
        importPath: "src/orders.controller",
        file: "src/orders.controller.ts",
        routes: [{
          method: "POST",
          path: "/",
          handler: "create",
          response: "CreatedOrder",
          responses: {
            "201": "CreatedOrder",
            "409": "OrderConflict",
          },
        }],
      }],
    }],
  };

  const manifest = buildContractManifest(graph, { client: true, openapi: true, permissions: true });
  expect(manifest.routes).toEqual([expect.objectContaining({
    responseSchema: "CreatedOrder",
    responseSchemas: {
      "201": "CreatedOrder",
      "409": "OrderConflict",
    },
  })]);
});
