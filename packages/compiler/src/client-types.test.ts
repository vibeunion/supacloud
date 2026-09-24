import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "@typescript/typescript6";
import { renderClient } from "./generate";
import type { ApplicationGraph } from "./types";
import { writeFixtureProject } from "./fixtures/helpers";

const typeboxPath = join(import.meta.dir, "../node_modules/@sinclair/typebox");

const graph: ApplicationGraph = {
  externalTokens: [],
  modules: [{
    name: "items", className: "ItemsModule", file: "items.ts", line: 1,
    imports: [], providers: [], commands: [], queries: [], exports: [],
    controllers: [{
      className: "ItemsController", path: "/tenants/:tenantId", scope: "request",
      deps: [], file: "items.ts", importPath: "./items",
      routes: [{ method: "GET", path: "/items/:id", pathParams: ["id"], handler: "get" }],
    }],
  }],
};

test("generated client requires inherited path parameters and a decoder for typed responses", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-client-types-"));
  try {
    await writeFixtureProject(root, {
      "client.ts": renderClient(graph),
      "consumer.ts": [
        'import { createApiClient } from "./client";',
        "const client = createApiClient();",
        'const options = { params: { tenantId: "tenant", id: 1 } };',
        "const raw: Promise<unknown> = client.items.get(options);",
        "const typed: Promise<string> = client.items.get(options, String);",
        "// @ts-expect-error Options cannot be omitted when path parameters are required.",
        "client.items.get();",
        "// @ts-expect-error Inherited controller parameters are required.",
        'client.items.get({ params: { id: 1 } });',
        "// @ts-expect-error A decoder is required before consuming a typed result.",
        "const wrong: Promise<string> = client.items.get(options);",
        "// @ts-expect-error Caller generics cannot fabricate a checked result.",
        "client.items.get<string>(options);",
      ].join("\n"),
    });
    const program = ts.createProgram([join(root, "consumer.ts")], {
      strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
      noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, types: [], skipLibCheck: true,
      ignoreDeprecations: "6.0",
      baseUrl: root,
      paths: { "@sinclair/typebox": [typeboxPath] },
    });
    expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")))
      .toEqual([]);
    const client = await import(pathToFileURL(join(root, "client.ts")).href);
    let calls = 0;
    const api = client.createApiClient({
      baseUrl: "https://example.test",
      fetch: async (url: string) => {
        calls++;
        expect(url).toBe("https://example.test/tenants/a%2Fb/items/1");
        return Response.json({ ok: true });
      },
    });
    await expect(api.items.get({ params: { id: 1 } })).rejects.toThrow("tenantId");
    expect(calls).toBe(0);
    await api.items.get({ params: { tenantId: "a/b", id: 1 } });
    expect(calls).toBe(1);
    expect(client.buildRouteUrl("/:id/:idLong", { id: "a", idLong: "b" })).toBe("/a/b");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generated client requires request sections covered by route schemas", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-client-request-types-"));
  try {
    const schemaGraph: ApplicationGraph = {
      externalTokens: [],
      modules: [{
        name: "items", className: "ItemsModule", file: "items.ts", line: 1,
        imports: [], providers: [], commands: [], queries: [], exports: [],
        controllers: [{
          className: "ItemsController", path: "/items", scope: "application",
          deps: [], file: "items.ts", importPath: "./items",
          schemaImports: {
            Body: "./schemas",
            Headers: "./schemas",
            Cookie: "./schemas",
            Result: "./schemas",
          },
          routes: [{
            method: "POST", path: "/create", handler: "create",
            body: "Body", headers: "Headers", cookie: "Cookie", response: "Result",
          }],
        }],
      }],
    };
    await writeFixtureProject(root, {
      "client.ts": renderClient(schemaGraph),
      "schemas.ts": [
        'import { Type } from "@sinclair/typebox";',
        'export const Body = Type.Object({ name: Type.String() });',
        'export const Headers = Type.Object({ authorization: Type.String() });',
        'export const Cookie = Type.Object({ session: Type.String() });',
        'export const Result = Type.Object({ id: Type.String() });',
      ].join("\n"),
      "consumer.ts": [
        'import { createApiClient } from "./client";',
        "const client = createApiClient();",
        "// @ts-expect-error Declared body schemas make body required.",
        "client.items.create({ headers: { authorization: \"token\" }, cookie: { session: \"s\" } });",
        "// @ts-expect-error Declared header schemas make headers required.",
        "client.items.create({ body: { name: \"item\" }, cookie: { session: \"s\" } });",
        "// @ts-expect-error Declared cookie schemas make cookie required.",
        "client.items.create({ body: { name: \"item\" }, headers: { authorization: \"token\" } });",
        "const valid: Promise<{ id: string }> = client.items.create({ body: { name: \"item\" }, headers: { authorization: \"token\" }, cookie: { session: \"s\" } });",
        "void valid;",
      ].join("\n"),
    });
    const program = ts.createProgram([join(root, "consumer.ts")], {
      strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
      noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, types: [], skipLibCheck: true,
      ignoreDeprecations: "6.0",
      baseUrl: root,
      paths: { "@sinclair/typebox": [typeboxPath] },
    });
    expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")))
      .toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generated client requires params when a params schema exists without a path token", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-client-params-schema-"));
  try {
    const paramsGraph: ApplicationGraph = {
      externalTokens: [],
      modules: [{
        name: "items", className: "ItemsModule", file: "items.ts", line: 1,
        imports: [], providers: [], commands: [], queries: [], exports: [],
        controllers: [{
          className: "ItemsController", path: "/items", scope: "application",
          deps: [], file: "items.ts", importPath: "./items",
          schemaImports: { Params: "./schemas" },
          routes: [{ method: "GET", path: "/search", handler: "search", params: "Params" }],
        }],
      }],
    };
    await writeFixtureProject(root, {
      "client.ts": renderClient(paramsGraph),
      "schemas.ts": [
        'import { Type } from "@sinclair/typebox";',
        'export const Params = Type.Object({ owner: Type.String() });',
      ].join("\n"),
      "consumer.ts": [
        'import { createApiClient } from "./client";',
        "const client = createApiClient();",
        "// @ts-expect-error A declared params schema makes params required even without :path syntax.",
        "client.items.search();",
        "const valid: Promise<unknown> = client.items.search({ params: { owner: \"team\" } });",
        "void valid;",
      ].join("\n"),
    });
    const program = ts.createProgram([join(root, "consumer.ts")], {
      strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
      noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, types: [], skipLibCheck: true,
      ignoreDeprecations: "6.0", baseUrl: root,
      paths: { "@sinclair/typebox": [typeboxPath] },
    });
    expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")))
      .toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changing the shared route contract rejects stale callers without handwritten client types", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-client-contract-evolution-"));
  try {
    const contractGraph: ApplicationGraph = {
      ...graph,
      modules: [{
        ...graph.modules[0]!,
        controllers: [{
          ...graph.modules[0]!.controllers[0]!,
          path: "/items",
          schemaImports: { Body: "./schemas", Result: "./schemas" },
          routes: [{ method: "POST", path: "/", handler: "create", body: "Body", responses: { 201: "Result" } }],
        }],
      }],
    };
    const diagnostics = () => {
      const program = ts.createProgram([join(root, "consumer.ts")], {
        strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
        noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler, types: [], skipLibCheck: true,
        ignoreDeprecations: "6.0", baseUrl: root,
        paths: { "@sinclair/typebox": [typeboxPath] },
      });
      return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    };
    await writeFixtureProject(root, {
      "client.ts": renderClient(contractGraph, { rootDir: root, outDir: root }),
      "schemas.ts": [
        'import { Type } from "@sinclair/typebox";',
        'export const Body = Type.Object({ amount: Type.Number() });',
        'export const Result = Type.Object({ id: Type.String() });',
      ].join("\n"),
      "consumer.ts": [
        'import { createApiClient, ApiClientError } from "./client";',
        "const client = createApiClient();",
        "const result = await client.items.create({ body: { amount: 10 } });",
        "const id: string = result.id;",
        "try { await client.items.create({ body: { amount: 20 } }); } catch (error) {",
        "  if (error instanceof ApiClientError) { const status: number = error.status; void status; }",
        "}",
        "void id;",
      ].join("\n"),
    });
    expect(diagnostics()).toEqual([]);
    await writeFixtureProject(root, {
      "schemas.ts": [
        'import { Type } from "@sinclair/typebox";',
        'export const Body = Type.Object({ total: Type.Number() });',
        'export const Result = Type.Object({ receiptId: Type.String() });',
      ].join("\n"),
    });
    const stale = diagnostics();
    expect(stale.some((message) => message.includes("amount"))).toBe(true);
    expect(stale.some((message) => message.includes("id"))).toBe(true);
    await writeFixtureProject(root, {
      "consumer.ts": [
        'import { createApiClient } from "./client";',
        "const result = await createApiClient().items.create({ body: { total: 10 } });",
        "const receiptId: string = result.receiptId;",
        "// @ts-expect-error The server contract, not a caller generic, determines the result.",
        "const fabricated: number = result.receiptId;",
        "void receiptId; void fabricated;",
      ].join("\n"),
    });
    expect(diagnostics()).toEqual([]);
    await symlink(join(import.meta.dir, "../node_modules"), join(root, "node_modules"), "dir");
    const build = await Bun.build({ entrypoints: [join(root, "client.ts")], target: "browser" });
    expect(build.success).toBe(true);
    const browserCode = await build.outputs[0]!.text();
    expect(browserCode).not.toContain("@supacloud/elysia");
    expect(browserCode).not.toContain("@supacloud/commands");
    expect(browserCode).not.toContain("class ItemsController");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
