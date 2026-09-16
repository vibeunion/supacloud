import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { renderClient } from "./generate";
import type { ApplicationGraph } from "./types";
import { writeFixtureProject } from "./fixtures/helpers";

const graph: ApplicationGraph = {
  externalTokens: [],
  modules: [{
    name: "items",
    className: "ItemsModule",
    file: "src/items.module.ts",
    line: 1,
    imports: [],
    providers: [],
    commands: [],
    queries: [],
    exports: [],
    controllers: [{
      className: "ItemsController",
      path: "/items",
      scope: "application",
      deps: [],
      file: "src/items.controller.ts",
      importPath: "src/items.controller",
      schemaImports: {
        Result: "src/contracts",
        Conflict: "src/contracts",
        Fallback: "src/contracts",
        Empty: "src/contracts",
      },
      routes: [{
        method: "GET",
        path: "/result",
        handler: "result",
        responses: { "200": "Result", "409": "Conflict", default: "Fallback" },
      }, {
        method: "DELETE",
        path: "/empty",
        handler: "empty",
        responses: { "204": "Empty" },
      }],
    }],
  }],
};

test("generated client decodes declared non-2xx/default responses and no-content statuses", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-client-runtime-"));
  try {
    await writeFixtureProject(root, {
      "generated/client.ts": renderClient(graph, { rootDir: root, outDir: join(root, "generated") }),
      "src/contracts.ts": [
        'export const Result = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };',
        'export const Conflict = { type: "object", properties: { conflict: { type: "boolean" } }, required: ["conflict"] };',
        'export const Fallback = { type: "object", properties: { fallback: { type: "boolean" } }, required: ["fallback"] };',
        'export const Empty = { type: "undefined" };',
      ].join("\n"),
    });
    const generated = await import(pathToFileURL(join(root, "generated/client.ts")).href);
    const statuses = [409, 404, 200];
    const client = generated.createApiClient({
      baseUrl: "https://example.test",
      fetch: async (url: string) => {
        if (url.endsWith("/empty")) return new Response(null, { status: 204 });
        const status = statuses.shift() ?? 200;
        const body = status === 409 ? { conflict: true }
          : status === 404 ? { fallback: true } : { ok: true };
        return Response.json(body, { status });
      },
    });

    await expect(client.items.result()).resolves.toEqual({ conflict: true });
    await expect(client.items.result()).resolves.toEqual({ fallback: true });
    await expect(client.items.result()).resolves.toEqual({ ok: true });
    await expect(client.items.empty()).resolves.toBeUndefined();
    expect(generated.decodeResponseSchema({ fallback: true }, 418, {
      "4XX": { type: "object", properties: { fallback: { type: "boolean" } }, required: ["fallback"] },
    })).toEqual({ fallback: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generated client validates structured JSON constraints and local refs", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-client-structured-"));
  try {
    const baseModule = graph.modules[0];
    const baseController = baseModule?.controllers[0];
    if (!baseModule || !baseController) throw new Error("Fixture graph is incomplete");
    const structuredGraph: ApplicationGraph = {
      ...graph,
      modules: [{
        ...baseModule,
        controllers: [{
          ...baseController,
          routes: [{
            method: "GET",
            path: "/structured",
            handler: "structured",
            response: "Result",
          }],
        }],
      }],
    };
    await writeFixtureProject(root, {
      "generated/client.ts": renderClient(structuredGraph, { rootDir: root, outDir: join(root, "generated") }),
      "src/contracts.ts": [
        'export const Result = { $defs: { payload: { type: "object", properties: { id: { type: "string", minLength: 2 }, tags: { type: "array", items: { type: "string" }, minItems: 1 } }, required: ["id", "tags"], additionalProperties: false } }, $ref: "#/$defs/payload" };',
      ].join("\n"),
    });
    const generated = await import(pathToFileURL(join(root, "generated/client.ts")).href);
    const client = generated.createApiClient({
      fetch: async () => Response.json({ id: "ok", tags: ["one"] }),
    });
    await expect(client.items.structured()).resolves.toEqual({ id: "ok", tags: ["one"] });

    const invalidClient = generated.createApiClient({
      fetch: async () => Response.json({ id: "x", tags: [], extra: true }),
    });
    await expect(invalidClient.items.structured()).rejects.toThrow("Response does not match schema");
    expect(generated.decodeResponseSchema("ok", 200, {
      200: { not: { const: "no" } },
    })).toBe("ok");
    expect(() => generated.decodeResponseSchema("no", 200, {
      200: { not: { const: "no" } },
    })).toThrow("Response does not match schema");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
