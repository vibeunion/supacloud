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
        pathParams: ["tenantId", "orderId"],
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

  test("marks root-optional request bodies as optional in OpenAPI", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-openapi-optional-body-"));
    try {
      const optionalGraph: ApplicationGraph = {
        externalTokens: [],
        modules: [{
          name: "payloads",
          className: "PayloadsModule",
          file: "src/payloads.module.ts",
          line: 1,
          imports: [],
          providers: [],
          commands: [],
          queries: [],
          exports: [],
          controllers: [{
            className: "PayloadsController",
            path: "/payloads",
            scope: "request",
            deps: [],
            file: "src/payloads.controller.ts",
            importPath: "src/payloads.controller",
            schemaImports: {
              OptionalBody: "src/contracts",
              UnionOptionalBody: "src/contracts",
              RequiredBody: "src/contracts",
            },
            routes: [
              { method: "POST", path: "/optional", handler: "optional", body: "OptionalBody" },
              { method: "POST", path: "/union", handler: "union", body: "UnionOptionalBody" },
              { method: "POST", path: "/required", handler: "required", body: "RequiredBody" },
            ],
          }],
        }],
      };
      await writeFixtureProject(root, {
        "src/contracts.ts": [
          'const typeBoxOptional = Symbol("TypeBox.Optional");',
          'export const OptionalBody = Object.assign({ type: "object", properties: { note: { type: "string" } } }, { [typeBoxOptional]: "Optional" });',
          'export const UnionOptionalBody = { anyOf: [{ type: "object", properties: { note: { type: "string" } } }, { type: "undefined" }] };',
          'export const RequiredBody = { type: "object", properties: { note: { type: "string" } } };',
        ].join("\n"),
        "generated/openapi.ts": renderOpenApi(optionalGraph, {
          rootDir: root,
          outDir: join(root, "generated"),
        }),
      });

      const generated = await import(pathToFileURL(join(root, "generated/openapi.ts")).href);
      const document = record(generated.OPENAPI_DOCUMENT);
      const paths = record(document.paths);
      expect(record(record(paths["/payloads/optional"]).post).requestBody).toMatchObject({ required: false });
      expect(record(record(paths["/payloads/union"]).post).requestBody).toMatchObject({ required: false });
      expect(record(record(paths["/payloads/required"]).post).requestBody).toMatchObject({ required: true });
      const schemas = record(record(document.components).schemas);
      const unionSchema = record(schemas.UnionOptionalBody);
      const unionVariants = list(unionSchema.anyOf);
      expect(unionVariants).toHaveLength(1);
      expect(unionVariants[0]).toMatchObject({ type: "object" });
      expect(unionVariants).not.toContainEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("follows local defs and registry refs when detecting optional bodies", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-openapi-ref-optional-body-"));
    try {
      const refGraph: ApplicationGraph = {
        externalTokens: [],
        modules: [{
          name: "refs",
          className: "RefsModule",
          file: "src/refs.module.ts",
          line: 1,
          imports: [],
          providers: [],
          commands: [],
          queries: [],
          exports: [],
          controllers: [{
            className: "RefsController",
            path: "/refs",
            scope: "request",
            deps: [],
            file: "src/refs.controller.ts",
            importPath: "src/refs.controller",
            schemaImports: {
              LocalRefOptionalBody: "src/contracts",
              RegistryRefOptionalBody: "src/contracts",
              OneOfUndefinedBody: "src/contracts",
              OptionalTarget: "src/contracts",
            },
            routes: [
              { method: "POST", path: "/local", handler: "local", body: "LocalRefOptionalBody" },
              { method: "POST", path: "/registry", handler: "registry", body: "RegistryRefOptionalBody" },
              { method: "POST", path: "/one-of", handler: "oneOf", body: "OneOfUndefinedBody" },
              { method: "POST", path: "/target", handler: "target", body: "OptionalTarget" },
            ],
          }],
        }],
      };
      await writeFixtureProject(root, {
        "src/contracts.ts": [
          'export const LocalRefOptionalBody = { $ref: "#/$defs/MaybePayload", $defs: { MaybePayload: { oneOf: [{ type: "object", properties: { note: { type: "string" } } }, { type: "undefined" }] } } };',
          'export const OptionalTarget = { $id: "optional-target", anyOf: [{ type: "object", properties: { note: { type: "string" } } }, { type: "undefined" }] };',
          'export const RegistryRefOptionalBody = { $ref: "optional-target" };',
          'export const OneOfUndefinedBody = { oneOf: [{ type: "undefined" }] };',
        ].join("\n"),
        "generated/openapi.ts": renderOpenApi(refGraph, {
          rootDir: root,
          outDir: join(root, "generated"),
        }),
      });

      const generated = await import(pathToFileURL(join(root, "generated/openapi.ts")).href);
      const document = record(generated.OPENAPI_DOCUMENT);
      const paths = record(document.paths);
      expect(record(record(paths["/refs/local"]).post).requestBody).toMatchObject({ required: false });
      expect(record(record(paths["/refs/registry"]).post).requestBody).toMatchObject({ required: false });
      expect(record(record(paths["/refs/one-of"]).post).requestBody).toMatchObject({ required: false });

      const schemas = record(record(document.components).schemas);
      const localSchema = record(schemas.LocalRefOptionalBody);
      const localDefs = record(localSchema.$defs);
      const localTarget = record(localDefs.MaybePayload);
      expect(list(localTarget.oneOf)).toHaveLength(1);
      expect(localTarget.oneOf).not.toContainEqual({});
      expect(schemas.OneOfUndefinedBody).toEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses JSON media types for non-success responses in binary and stream maps", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-openapi-transport-map-"));
    try {
      const transportGraph: ApplicationGraph = {
        externalTokens: [],
        modules: [{
          name: "media",
          className: "MediaModule",
          file: "src/media.module.ts",
          line: 1,
          imports: [],
          providers: [],
          commands: [],
          queries: [],
          exports: [],
          controllers: [{
            className: "MediaController",
            path: "/media",
            scope: "request",
            deps: [],
            file: "src/media.controller.ts",
            importPath: "src/media.controller",
            schemaImports: {
              BinaryResult: "src/contracts",
              StreamResult: "src/contracts",
              NotFound: "src/contracts",
            },
            routes: [
              {
                method: "GET",
                path: "/download",
                handler: "download",
                responses: { "200": "BinaryResult", "404": "NotFound" },
                contract: { response: "binary", evidence: "openapi.test.ts" },
              },
              {
                method: "GET",
                path: "/events",
                handler: "events",
                responses: { "2xx": "StreamResult", "409": "NotFound", default: "NotFound" },
                contract: { response: "stream", evidence: "openapi.test.ts" },
              },
            ],
          }],
        }],
      };
      await writeFixtureProject(root, {
        "src/contracts.ts": [
          'export const BinaryResult = { type: "string", format: "binary" };',
          'export const StreamResult = { type: "string", format: "binary" };',
          'export const NotFound = { type: "object", properties: { code: { type: "string" } }, required: ["code"] };',
        ].join("\n"),
        "generated/openapi.ts": renderOpenApi(transportGraph, {
          rootDir: root,
          outDir: join(root, "generated"),
        }),
      });

      const generated = await import(pathToFileURL(join(root, "generated/openapi.ts")).href);
      const document = record(generated.OPENAPI_DOCUMENT);
      const paths = record(document.paths);
      const downloadResponses = record(record(record(paths["/media/download"]).get).responses);
      expect(record(downloadResponses["200"]).content).toHaveProperty("application/octet-stream");
      expect(record(downloadResponses["404"]).content).toHaveProperty("application/json");
      expect(record(downloadResponses["404"]).content).not.toHaveProperty("application/octet-stream");
      const eventResponses = record(record(record(paths["/media/events"]).get).responses);
      expect(record(eventResponses["2XX"]).content).toHaveProperty("application/octet-stream");
      expect(record(eventResponses["409"]).content).toHaveProperty("application/json");
      expect(record(eventResponses.default).content).toHaveProperty("application/json");
      // A declared status family/default owns the matching status. Do not
      // reintroduce an exact framework response that would win over it.
      expect(eventResponses["422"]).toBeUndefined();
      expect(eventResponses["500"]).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
