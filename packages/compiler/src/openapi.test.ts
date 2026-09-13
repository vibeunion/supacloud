import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "@typescript/typescript6";
import { checkProject, compileProject } from "./compile";
import { renderOpenApi } from "./generate";
import { GOOD_PROJECT_FILES } from "./fixtures/good-project";
import { writeFixtureProject } from "./fixtures/helpers";
import type { ApplicationGraph } from "./types";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return Object.fromEntries(Object.entries(value));
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected an array");
  return value;
}

const graph: ApplicationGraph = {
  externalTokens: [],
  modules: [{
    name: "orders",
    className: "OrdersModule",
    file: "src/orders.module.ts",
    line: 1,
    imports: [],
    providers: [],
    commands: [{
      className: "CreateOrderCommand",
      name: "orders.create",
      permission: "orders.create",
      transaction: "required",
      idempotency: "required",
    }],
    queries: [],
    exports: [],
    controllers: [{
      className: "OrdersController",
      path: "/tenants/:tenantId/orders",
      scope: "request",
      deps: [],
      file: "src/orders.controller.ts",
      importPath: "src/orders.controller",
      schemaImports: {
        OrderParams: "src/contracts",
        OrderQuery: "src/contracts",
        CreateOrderBody: "src/contracts",
        OrderResponse: "src/contracts",
      },
      routes: [{
        method: "POST",
        path: "/:orderId",
        handler: "create",
        pathParams: ["orderId"],
        queryBindings: ["includeHistory"],
        params: "OrderParams",
        query: "OrderQuery",
        body: "CreateOrderBody",
        response: "OrderResponse",
        command: "CreateOrderCommand",
        guards: ["requirePrincipal"],
        title: "Create order",
        data: { area: "orders" },
        contract: {
          body: "framework",
          response: "framework",
          evidence: "orders.http.test.ts",
        },
      }],
    }],
  }],
};

describe("OpenAPI generator", () => {
  test("renders imported schemas, parameters, security metadata and a strict consumer module", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-openapi-render-"));
    try {
      await writeFixtureProject(root, {
        "src/contracts.ts": `
export const OrderParams = {
  type: "object",
  properties: { tenantId: { type: "string" }, orderId: { type: "string" } },
  required: ["tenantId", "orderId"],
};
export const OrderQuery = {
  type: "object",
  properties: { includeHistory: { type: "boolean", default: false } },
};
const PositiveQuantity = { type: "integer", minimum: 1 };
export const CreateOrderBody = {
  type: "object",
  properties: { sku: { type: "string" }, quantity: PositiveQuantity, reserve: PositiveQuantity },
  required: ["sku", "quantity", "reserve"],
};
export const OrderResponse = {
  type: "object",
  properties: { id: { type: "string" }, accepted: { type: "boolean" } },
  required: ["id", "accepted"],
};
`,
        "generated/openapi.ts": renderOpenApi(graph, {
          rootDir: root,
          outDir: join(root, "generated"),
          openApi: {
            title: "Orders API",
            version: "1.2.0",
            description: "Order management API",
            servers: [{ url: "https://orders.example.test", description: "test" }],
            securitySchemes: {
              serviceToken: { type: "apiKey", name: "x-service-token", in: "header" },
            },
          },
        }),
        "consumer.ts": [
          'import { OPENAPI_DOCUMENT, type OpenApiDocument } from "./generated/openapi";',
          "const document: OpenApiDocument = OPENAPI_DOCUMENT;",
          "void document;",
        ].join("\n"),
      });

      const program = ts.createProgram([join(root, "consumer.ts")], {
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        types: [],
      });
      expect(ts.getPreEmitDiagnostics(program).map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);

      const generated = await import(pathToFileURL(join(root, "generated/openapi.ts")).href);
      const document = record(generated.OPENAPI_DOCUMENT);
      expect(document.openapi).toBe("3.1.0");
      expect(document.info).toEqual({
        title: "Orders API",
        version: "1.2.0",
        description: "Order management API",
      });
      expect(document.servers).toEqual([{
        url: "https://orders.example.test",
        description: "test",
      }]);

      const components = record(document.components);
      const schemas = record(components.schemas);
      expect(Object.keys(schemas).sort()).toEqual([
        "CreateOrderBody", "OrderParams", "OrderQuery", "OrderResponse", "SupaCloudError",
      ]);
      expect(record(components.securitySchemes)).toMatchObject({
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        serviceToken: { type: "apiKey", name: "x-service-token", in: "header" },
      });

      const pathItem = record(record(document.paths)["/tenants/{tenantId}/orders/{orderId}"]);
      const operation = record(pathItem.post);
      expect(operation.operationId).toBe("OrdersOrdersControllerCreate");
      expect(operation.summary).toBe("Create order");
      const parameters = list(operation.parameters).map(record);
      expect(parameters).toHaveLength(3);
      expect(parameters[0]).toMatchObject({
        name: "tenantId", in: "path", required: true,
        schema: { type: "string" },
      });
      expect(parameters[1]).toMatchObject({
        name: "orderId", in: "path", required: true,
        schema: { type: "string" },
      });
      expect(parameters[2]).toMatchObject({
        name: "includeHistory", in: "query", required: false,
        schema: { type: "boolean", default: false },
      });
      expect(operation.requestBody).toEqual({
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/CreateOrderBody" } } },
      });
      const responses = record(operation.responses);
      expect(responses["200"]).toEqual({
        description: "Successful response",
        content: { "application/json": { schema: { $ref: "#/components/schemas/OrderResponse" } } },
      });
      expect(operation.security).toEqual([{ bearerAuth: [] }]);
      expect(operation["x-supacloud"]).toMatchObject({
        module: "orders",
        controller: "OrdersController",
        handler: "create",
        command: "CreateOrderCommand",
        permission: "orders.create",
        guards: ["requirePrincipal"],
        contract: { body: "framework", response: "framework", evidence: "orders.http.test.ts" },
        data: { area: "orders" },
      });
      const bodySchema = record(schemas.CreateOrderBody);
      const bodyProperties = record(bodySchema.properties);
      expect(bodyProperties.sku).toEqual({ type: "string" });
      expect(bodyProperties.quantity).toEqual({ type: "integer", minimum: 1 });
      expect(bodyProperties.reserve).toEqual({ type: "integer", minimum: 1 });
      expect(JSON.parse(generated.OPENAPI_JSON)).toEqual(document);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("compile and check include openapi.ts and detect its drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-openapi-check-"));
    try {
      await writeFixtureProject(root, GOOD_PROJECT_FILES);
      const outDir = join(root, "generated");
      const compiled = await compileProject({ rootDir: root, outDir, generateOpenApi: true });
      expect(compiled.diagnostics).toEqual([]);
      expect(compiled.written).toContain(join(outDir, "openapi.ts"));

      const matching = await checkProject({ rootDir: root, outDir, generateOpenApi: true });
      expect(matching.upToDate).toBe(true);
      const openApiPath = join(outDir, "openapi.ts");
      const original = await readFile(openApiPath, "utf8");
      try {
        await writeFile(openApiPath, `${original}// drift\n`, "utf8");
        const drifted = await checkProject({ rootDir: root, outDir, generateOpenApi: true });
        expect(drifted.upToDate).toBe(false);
        expect(drifted.mismatches).toContain("openapi.ts: disk artifact differs from current compiler output");
      } finally {
        await writeFile(openApiPath, original, "utf8");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
