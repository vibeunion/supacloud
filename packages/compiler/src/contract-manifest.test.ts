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
          idempotency: "required",
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
    idempotency: "required",
    responseSchema: "CreatedOrder",
    responseSchemas: {
      "201": "CreatedOrder",
      "409": "OrderConflict",
    },
  })]);
});

test("contract manifest preserves tenant boundaries for commands and queries", () => {
  const graph: ApplicationGraph = {
    externalTokens: [],
    modules: [{
      name: "cases",
      className: "CasesModule",
      file: "src/cases.module.ts",
      line: 1,
      imports: [],
      providers: [],
      commands: [{
        className: "ApproveCase",
        name: "case.approve",
        permission: "case.approve",
        transaction: "required",
        idempotency: "required",
        tenantScope: "required",
      }],
      queries: [{
        className: "ListCases",
        name: "case.list",
        tenantScope: "required",
      }],
      exports: [],
      controllers: [],
    }],
  };

  expect(buildContractManifest(graph, { client: false, openapi: false, permissions: false }))
    .toMatchObject({
      commands: [{ name: "case.approve", tenantScope: "required" }],
      queries: [{ name: "case.list", tenantScope: "required" }],
    });
});

test("contract manifest resolves direct route commands by class name or logical name", () => {
  const graph: ApplicationGraph = {
    externalTokens: [],
    modules: [{
      name: "cases",
      className: "CasesModule",
      file: "src/cases.module.ts",
      line: 1,
      imports: [],
      providers: [],
      commands: [{
        className: "ApproveCase",
        name: "case.approve",
        permission: "case.approve",
        transaction: "required",
        idempotency: "required",
        tenantScope: "required",
      }],
      queries: [],
      exports: [],
      controllers: [{
        className: "CasesController",
        path: "/cases",
        scope: "request",
        deps: [],
        file: "src/cases.controller.ts",
        importPath: "src/cases.controller",
        routes: [{
          method: "POST",
          path: "/approve",
          handler: "approve",
          command: "case.approve",
        }],
      }],
    }],
  };

  expect(buildContractManifest(graph, { client: false, openapi: false, permissions: true }).routes)
    .toEqual([expect.objectContaining({
      command: "case.approve",
      permission: "case.approve",
      idempotency: "required",
    })]);
});

test("contract manifest publishes the complete feature state machine and persistence policy", () => {
  const graph: ApplicationGraph = {
    externalTokens: [],
    modules: [{
      name: "cases",
      className: "CasesModule",
      file: "src/cases.module.ts",
      line: 1,
      imports: [],
      providers: [],
      commands: [],
      queries: [],
      exports: [],
      controllers: [],
      jobs: [{
        className: "RefreshCaseJob", name: "case.refresh", serviceKey: "refreshCaseJob",
        scope: "job", input: "RefreshCaseInput", output: "RefreshCaseOutput",
        schemaKinds: { input: "declared", output: "declared" },
        mode: "workflow", idempotency: "required", tenantScope: "required",
      }],
      featureSpec: {
        name: "case",
        states: ["draft", "approved"],
        database: {
          source: "db/schema.ts",
          table: "public.reviews",
          rowType: "ReviewRow",
        },
        tenantField: "tenant_id",
        transitions: [{
          name: "approve", from: "draft", to: "approved",
          permission: "case.approve", command: "ApproveCase",
          job: "case.refresh",
          transaction: "required", idempotency: "required", audit: "case.approved",
          persistence: {
            boundary: "database", optimisticLock: "required",
            versionField: "version", tenantField: "tenant_id", stateField: "state",
            receipt: "required", reconciliation: "none",
          },
        }],
      },
    }],
  };

  expect(buildContractManifest(graph, { client: false, openapi: false, permissions: false }))
    .toMatchObject({
      jobs: [{
        name: "case.refresh",
        className: "RefreshCaseJob",
        module: "cases",
        input: "RefreshCaseInput",
        output: "RefreshCaseOutput",
        mode: "workflow",
        idempotency: "required",
        tenantScope: "required",
      }],
      features: [{
        name: "case",
        states: ["draft", "approved"],
        database: {
          source: "db/schema.ts",
          table: "public.reviews",
          rowType: "ReviewRow",
        },
        tenantField: "tenant_id",
        transitions: [{
          name: "approve",
          job: "case.refresh",
          jobDetails: {
            name: "case.refresh",
            className: "RefreshCaseJob",
            input: "RefreshCaseInput",
            inputKind: "declared",
            output: "RefreshCaseOutput",
            outputKind: "declared",
            mode: "workflow",
            idempotency: "required",
            tenantScope: "required",
          },
          persistence: {
            boundary: "database",
            versionField: "version",
            tenantField: "tenant_id",
            stateField: "state",
          },
        }],
      }],
    });
});
