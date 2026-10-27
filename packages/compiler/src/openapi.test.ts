import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "@typescript/typescript6";
import { checkProject, compileProject } from "./compile";
import { renderOpenApi } from "./generate";
import { exportGeneratedOpenApiJson, loadGeneratedOpenApiDocument, OpenApiDocumentError } from "./openapi-tools";
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
        idempotency: "required",
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
  test("factory-only imports defer schema conversion and support static JSON export", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-openapi-factory-"));
    try {
      const options = { rootDir: root, outDir: join(root, "generated") };
      await writeFixtureProject(root, {
        "src/contracts.ts": [
          "export let schemaReads = 0;",
          "export const OrderParams = { type: 'object' };",
          "export const OrderQuery = { type: 'object' };",
          "export const CreateOrderBody = { type: 'object' };",
          "export const OrderResponse = { get type() { schemaReads += 1; return 'object'; }, properties: { id: { type: 'string' } } };",
        ].join("\n"),
        "generated/openapi.ts": renderOpenApi(graph, { ...options, openApi: { snapshots: false } }),
        "generated/snapshot.ts": renderOpenApi(graph, options),
        "consumer.ts": [
          'import { createOpenApiDocument, serializeOpenApiDocument, type OpenApiDocument } from "./generated/openapi";',
          "const document: OpenApiDocument = createOpenApiDocument();",
          "const json: string = serializeOpenApiDocument(document);",
          "void json;",
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

      const schemas = await import(pathToFileURL(join(root, "src/contracts.ts")).href);
      const modulePath = join(root, "generated/openapi.ts");
      const generated = await import(pathToFileURL(modulePath).href);
      expect(schemas.schemaReads).toBe(0);
      expect("OPENAPI_DOCUMENT" in generated).toBe(false);
      expect("OPENAPI_JSON" in generated).toBe(false);

      const document = generated.createOpenApiDocument();
      expect(schemas.schemaReads).toBeGreaterThan(0);
      const snapshot = await import(pathToFileURL(join(root, "generated/snapshot.ts")).href);
      expect(document).toEqual(snapshot.OPENAPI_DOCUMENT);
      expect(generated.createOpenApiDocument()).not.toBe(document);
      expect(generated.serializeOpenApiDocument()).toBe(snapshot.OPENAPI_JSON);
      expect(generated.serializeOpenApiDocument(document, 0)).toBe(`${JSON.stringify(document)}\n`);

      const outputPath = join(root, "static/openapi.json");
      expect(await exportGeneratedOpenApiJson({ modulePath, outputPath })).toEqual({ path: outputPath, written: true });
      expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(document);
      expect(await exportGeneratedOpenApiJson({ modulePath, outputPath })).toEqual({ path: outputPath, written: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each(["OPENAPI_DOCUMENT", "createOpenApiDocument"])("bundled %s consumers remove unused snapshots", async (exportName) => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-openapi-tree-shaking-"));
    try {
      await writeFixtureProject(root, {
        "src/contracts.ts": [
          "export let schemaReads = 0;",
          "export const OrderParams = { type: 'object' };",
          "export const OrderQuery = { type: 'object' };",
          "export const CreateOrderBody = { type: 'object' };",
          "export const OrderResponse = { get type() { schemaReads += 1; return 'object'; } };",
        ].join("\n"),
        "openapi.ts": renderOpenApi(graph, { rootDir: root, outDir: root }),
        "consumer.ts": `export { ${exportName} } from "./openapi"; export { schemaReads } from "./src/contracts";`,
      });
      const build = await Bun.build({
        entrypoints: [join(root, "consumer.ts")],
        target: "bun",
        minify: true,
      });
      expect(build.success).toBe(true);
      const output = build.outputs[0];
      if (!output) throw new Error("Expected an OpenAPI consumer bundle");
      const bundlePath = join(root, "consumer.mjs");
      await writeFile(bundlePath, await output.text());
      // Observe serialization in a separate process so the test cannot affect other imports.
      const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", [
        "const stringify = JSON.stringify;",
        "let serializations = 0;",
        "JSON.stringify = (...args) => { serializations += 1; return stringify(...args); };",
        `const generated = await import(${JSON.stringify(pathToFileURL(bundlePath).href)});`,
        "const initialSchemaReads = generated.schemaReads;",
        "const document = generated.OPENAPI_DOCUMENT ?? generated.createOpenApiDocument();",
        "console.log(stringify({ serializations, initialSchemaReads, version: document.openapi }));",
      ].join("\n")], { stdout: "pipe", stderr: "pipe" });
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      expect({ exitCode: await child.exited, stderr }).toEqual({ exitCode: 0, stderr: "" });
      const result = record(JSON.parse(stdout));
      expect(result).toMatchObject({ serializations: 0, version: "3.1.0" });
      if (exportName === "createOpenApiDocument") expect(result.initialSchemaReads).toBe(0);
      else expect(result.initialSchemaReads).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("static export rejects invalid factories and never masks an invalid legacy snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-openapi-invalid-factory-"));
    try {
      const files = {
        "invalid.ts": "export const createOpenApiDocument = () => ({ paths: {} });",
        "throws.ts": "export const createOpenApiDocument = () => { throw new Error('private details'); };",
        "legacy.ts": "export const OPENAPI_DOCUMENT = null; export const createOpenApiDocument = () => ({ openapi: '3.1.0', info: {}, paths: {} });",
      };
      await writeFixtureProject(root, files);
      for (const file of Object.keys(files)) {
        await expect(loadGeneratedOpenApiDocument(join(root, file))).rejects.toThrow(OpenApiDocumentError);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
      expect(parameters).toHaveLength(4);
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
      expect(parameters[3]).toMatchObject({
        name: "Idempotency-Key", in: "header", required: true,
        schema: { type: "string", minLength: 1, maxLength: 512 },
      });
      expect(operation.requestBody).toEqual({
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/CreateOrderBody" } } },
      });
      const responses = record(operation.responses);
      expect(responses["400"]).toMatchObject({
        description: "Idempotency-Key is missing or invalid",
      });
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
        idempotency: "required",
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
      const factoryOptions = { rootDir: root, outDir, generateOpenApi: true, openApi: { snapshots: false } };
      const changedMode = await checkProject(factoryOptions);
      expect(changedMode.upToDate).toBe(false);
      expect(changedMode.mismatches).toContain("openapi.ts: disk artifact differs from current compiler output");
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
      expect((await compileProject(factoryOptions)).diagnostics).toEqual([]);
      expect((await checkProject(factoryOptions)).upToDate).toBe(true);
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

  test("preserves declared error responses for idempotency-required routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-openapi-idempotency-responses-"));
    try {
      const responseGraph: ApplicationGraph = {
        ...graph,
        modules: graph.modules.map((module) => ({
          ...module,
          controllers: module.controllers.map((controller): typeof controller => ({
            ...controller,
            path: "/idempotency",
            schemaImports: { Result: "src/contracts", DomainError: "src/contracts" },
            routes: [
              { method: "POST", path: "/exact", handler: "exact", idempotency: "required", responses: { "200": "Result", "400": "DomainError", "422": "DomainError", "500": "DomainError" } },
              { method: "POST", path: "/family", handler: "family", idempotency: "required", responses: { "200": "Result", "4xx": "DomainError" } },
              { method: "POST", path: "/default", handler: "default", idempotency: "required", responses: { "200": "Result", default: "DomainError" } },
              { method: "POST", path: "/missing", handler: "missing", idempotency: "required", responses: { "200": "Result" } },
              { method: "POST", path: "/none", handler: "none", idempotency: "none", responses: { "200": "Result" } },
            ],
          })),
        })),
      };
      await writeFixtureProject(root, {
        "src/contracts.ts": [
          'export const Result = { type: "object", properties: { ok: { type: "boolean" } } };',
          'export const DomainError = { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] };',
        ].join("\n"),
        "generated/openapi.ts": renderOpenApi(responseGraph, { rootDir: root, outDir: join(root, "generated") }),
      });
      const generated = await import(pathToFileURL(join(root, "generated/openapi.ts")).href);
      const paths = record(record(generated.OPENAPI_DOCUMENT).paths);
      const responsesFor = (path: string) => record(record(record(paths[path]).post).responses);
      const domainContent = { "application/json": { schema: { $ref: "#/components/schemas/DomainError" } } };
      const exact = responsesFor("/idempotency/exact");
      for (const status of ["400", "422", "500"]) expect(record(exact[status]).content).toEqual(domainContent);
      const family = responsesFor("/idempotency/family");
      expect(record(family["4XX"]).content).toEqual(domainContent);
      expect(family["400"]).toBeUndefined();
      expect(family["422"]).toBeUndefined();
      expect(record(family["500"]).description).toBe("Internal server error");
      const fallback = responsesFor("/idempotency/default");
      expect(record(fallback.default).content).toEqual(domainContent);
      for (const status of ["400", "422", "500"]) expect(fallback[status]).toBeUndefined();
      const missing = responsesFor("/idempotency/missing");
      expect(missing["400"]).toEqual({
        description: "Idempotency-Key is missing or invalid",
        content: { "application/json": { schema: { $ref: "#/components/schemas/SupaCloudError" } } },
      });
      expect(record(missing["422"]).description).toBe("Request validation failed");
      expect(record(missing["500"]).description).toBe("Internal server error");
      expect(responsesFor("/idempotency/none")["400"]).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("merges declared idempotency headers case-insensitively without losing constraints", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-openapi-idempotency-headers-"));
    try {
      const headerGraph: ApplicationGraph = {
        ...graph,
        modules: graph.modules.map((module) => ({
          ...module,
          controllers: module.controllers.map((controller): typeof controller => ({
            ...controller,
            path: "/idempotency",
            schemaImports: { ExactHeaders: "src/contracts", LowercaseHeaders: "src/contracts", DuplicateHeaders: "src/contracts" },
            routes: [
              { method: "POST", path: "/exact", handler: "exact", idempotency: "required", headers: "ExactHeaders" },
              { method: "POST", path: "/lowercase", handler: "lowercase", idempotency: "required", headers: "LowercaseHeaders" },
              { method: "POST", path: "/duplicates", handler: "duplicates", idempotency: "required", headers: "DuplicateHeaders" },
              { method: "POST", path: "/missing", handler: "missing", idempotency: "required" },
            ],
          })),
        })),
      };
      await writeFixtureProject(root, {
        "src/contracts.ts": [
          'const Key = { type: "string", minLength: 8, maxLength: 32, pattern: "^domain-" };',
          'export const ExactHeaders = { type: "object", properties: { "Idempotency-Key": Key } };',
          'export const LowercaseHeaders = { type: "object", properties: { "idempotency-key": Key } };',
          'export const DuplicateHeaders = { type: "object", properties: { "Idempotency-Key": Key, "IDEMPOTENCY-KEY": { type: "string", enum: ["domain-fixed"] } } };',
        ].join("\n"),
        "generated/openapi.ts": renderOpenApi(headerGraph, { rootDir: root, outDir: join(root, "generated") }),
      });
      const generated = await import(pathToFileURL(join(root, "generated/openapi.ts")).href);
      const paths = record(record(generated.OPENAPI_DOCUMENT).paths);
      const keySchema = { type: "string", minLength: 1, maxLength: 512, pattern: "^[A-Za-z0-9._:-]{1,512}$" };
      const declaredSchema = { type: "string", minLength: 8, maxLength: 32, pattern: "^domain-" };
      for (const path of ["exact", "lowercase", "duplicates", "missing"]) {
        const operation = record(record(paths[`/idempotency/${path}`]).post);
        const headers = list(operation.parameters).map(record).filter((parameter) =>
          parameter.in === "header" && String(parameter.name).toLowerCase() === "idempotency-key");
        expect(headers).toHaveLength(1);
        expect(headers[0]?.required).toBe(true);
        if (path === "missing") {
          expect(headers[0]?.schema).toEqual(keySchema);
        } else {
          const constraints = list(record(headers[0]?.schema).allOf);
          expect(constraints).toContainEqual(declaredSchema);
          expect(constraints).toContainEqual(keySchema);
          expect(constraints).toHaveLength(path === "duplicates" ? 3 : 2);
          if (path === "duplicates") expect(constraints).toContainEqual({ type: "string", enum: ["domain-fixed"] });
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
