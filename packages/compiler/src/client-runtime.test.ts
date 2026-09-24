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
    expect(generated.decodeResponseSchema(undefined, 200, {
      "200": { oneOf: [{ type: "undefined" }, { type: "string" }] },
    })).toBeUndefined();

    let decoderCalls = 0;
    const invalidClient = generated.createApiClient({
      fetch: async () => Response.json({ ok: "not-a-boolean" }, { status: 200 }),
    });
    await expect(invalidClient.items.result({}, (value: unknown) => {
      decoderCalls += 1;
      return value;
    })).rejects.toThrow("Response does not match schema");
    expect(decoderCalls).toBe(0);

    const transformedClient = generated.createApiClient({
      fetch: async () => Response.json({ ok: true }, { status: 200 }),
    });
    await expect(transformedClient.items.result({}, (value: unknown) => JSON.stringify(value)))
      .resolves.toBe('{"ok":true}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generated client lets JSON error responses override binary transport mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-client-transport-status-"));
  try {
    const baseModule = graph.modules[0];
    const baseController = baseModule?.controllers[0];
    if (!baseModule || !baseController) throw new Error("Fixture graph is incomplete");
    const transportGraph: ApplicationGraph = {
      ...graph,
      modules: [{
        ...baseModule,
        controllers: [{
        ...baseController,
          schemaImports: {
            ...baseController.schemaImports,
            Binary: "src/contracts",
            NotFound: "src/contracts",
          },
          routes: [{
            method: "GET",
            path: "/download",
            handler: "download",
            responses: { "200": "Binary", "404": "NotFound" },
            contract: { response: "binary", evidence: "client-runtime.test.ts" },
          }],
        }],
      }],
    };
    await writeFixtureProject(root, {
      "generated/client.ts": renderClient(transportGraph, { rootDir: root, outDir: join(root, "generated") }),
      "src/contracts.ts": [
        'export const Binary = { type: "any" };',
        'export const NotFound = { type: "object", properties: { code: { type: "string" } }, required: ["code"] };',
      ].join("\n"),
    });
    const generated = await import(pathToFileURL(join(root, "generated/client.ts")).href);
    const bytes = new Uint8Array([0, 255, 1, 128]);
    let calls = 0;
    const client = generated.createApiClient({
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(bytes, {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          });
        }
        return Response.json({ code: "NOT_FOUND" }, { status: 404 });
      },
    });

    const binary = await client.items.download();
    expect(new Uint8Array(binary as ArrayBuffer)).toEqual(bytes);
    await expect(client.items.download()).resolves.toEqual({ code: "NOT_FOUND" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generated client keeps successful binary responses raw when only errors are schematized", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-client-transport-success-fallback-"));
  try {
    const baseModule = graph.modules[0];
    const baseController = baseModule?.controllers[0];
    if (!baseModule || !baseController) throw new Error("Fixture graph is incomplete");
    const transportGraph: ApplicationGraph = {
      ...graph,
      modules: [{
        ...baseModule,
        controllers: [{
          ...baseController,
          schemaImports: { ...baseController.schemaImports, NotFound: "src/contracts" },
          routes: [{
            method: "GET",
            path: "/download-errors",
            handler: "downloadErrors",
            responses: { "404": "NotFound" },
            contract: { response: "binary", evidence: "client-runtime.test.ts" },
          }],
        }],
      }],
    };
    await writeFixtureProject(root, {
      "generated/client.ts": renderClient(transportGraph, { rootDir: root, outDir: join(root, "generated") }),
      "src/contracts.ts": [
        'export const NotFound = { type: "object", properties: { code: { type: "string" } }, required: ["code"] };',
      ].join("\n"),
    });
    const generated = await import(pathToFileURL(join(root, "generated/client.ts")).href);
    const bytes = new Uint8Array([3, 1, 4, 1, 5]);
    const client = generated.createApiClient({
      fetch: async () => new Response(bytes, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
    });
    expect(new Uint8Array(await client.items.downloadErrors() as ArrayBuffer)).toEqual(bytes);
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

    const normalizedClient = generated.createApiClient({
      fetch: async () => Response.json({ id: "x", tags: [], extra: true }),
    });
    await expect(normalizedClient.items.structured()).rejects.toThrow("Response does not match schema");
    const strictClient = generated.createApiClient({
      normalize: false,
      fetch: async () => Response.json({ id: "ok", tags: ["one"], extra: true }),
    });
    await expect(strictClient.items.structured()).rejects.toThrow("Response does not match schema");
    const normalizedExtraClient = generated.createApiClient({
      fetch: async () => Response.json({ id: "ok", tags: ["one"], extra: true }),
    });
    await expect(normalizedExtraClient.items.structured()).resolves.toEqual({ id: "ok", tags: ["one"] });
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

test("generated client rejects structured responses whose HTTP status is absent from the map", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-client-status-contract-"));
  try {
    const baseModule = graph.modules[0];
    const baseController = baseModule?.controllers[0];
    if (!baseModule || !baseController) throw new Error("Fixture graph is incomplete");
    const statusGraph: ApplicationGraph = {
      ...graph,
      modules: [{
        ...baseModule,
        controllers: [{
          ...baseController,
          routes: [{
            method: "GET",
            path: "/created",
            handler: "created",
            responses: { "201": "Result" },
          }],
        }],
      }],
    };
    await writeFixtureProject(root, {
      "generated/client.ts": renderClient(statusGraph, { rootDir: root, outDir: join(root, "generated") }),
      "src/contracts.ts": 'export const Result = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };',
    });
    const generated = await import(pathToFileURL(join(root, "generated/client.ts")).href);
    const client = generated.createApiClient({
      fetch: async () => Response.json({ ok: true }, { status: 200 }),
    });
    await expect(client.items.created()).rejects.toThrow("No response schema declared for HTTP 200");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generated client preserves successful streams and declared JSON errors on the same route", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-client-stream-"));
  try {
    const streamGraph: ApplicationGraph = {
      ...graph, modules: [{
        ...graph.modules[0]!,
        controllers: [{
          ...graph.modules[0]!.controllers[0]!,
          schemaImports: { Conflict: "src/contracts" },
          routes: [{
            method: "GET", path: "/events", handler: "events",
            responses: { 409: "Conflict" },
            contract: { response: "stream", evidence: "client-runtime.test.ts" },
          }],
        }],
      }],
    };
    await writeFixtureProject(root, {
      "generated/client.ts": renderClient(streamGraph, { rootDir: root, outDir: join(root, "generated") }),
      "src/contracts.ts": 'export const Conflict = { type: "object", properties: { conflict: { type: "boolean" } }, required: ["conflict"] };',
    });
    const generated = await import(pathToFileURL(join(root, "generated/client.ts")).href);
    const body = "data: ready\n\n";
    let requests = 0;
    const client = generated.createApiClient({
      fetch: async () => ++requests === 1
        ? new Response(body, { headers: { "content-type": "text/event-stream" } })
        : Response.json({ conflict: true }, { status: 409 }),
    });
    const stream = await client.items.events();
    expect(stream).toBeInstanceOf(ReadableStream);
    expect(await new Response(stream).text()).toBe(body);
    expect(await client.items.events()).toEqual({ conflict: true });
    expect(requests).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
