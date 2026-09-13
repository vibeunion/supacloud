import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  diffOpenApiDocuments,
  exportGeneratedOpenApiJson,
  formatOpenApiDiff,
  OpenApiDocumentError,
  readOpenApiJson,
  writeOpenApiJson,
} from "./openapi-tools";
import type { OpenApiDocument } from "./openapi-tools";

function document(overrides: {
  paths?: Record<string, unknown>;
  components?: Record<string, unknown>;
} = {}): OpenApiDocument {
  return {
    openapi: "3.1.0",
    info: { title: "Orders", version: "1.0.0" },
    paths: overrides.paths ?? {
      "/orders/{id}": {
        get: {
          parameters: [{
            name: "id", in: "path", required: true, schema: { type: "string" },
          }],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Order" },
                },
              },
            },
          },
        },
      },
    },
    components: overrides.components ?? {
      schemas: {
        Order: {
          type: "object",
          properties: { id: { type: "string" }, total: { type: "number" } },
          required: ["id", "total"],
        },
      },
    },
  };
}

describe("OpenAPI contract tools", () => {
  test("reports additions as non-breaking and response contract removals as breaking", () => {
    const current = document({
      paths: {
        "/orders/{id}": {
          get: {
            parameters: [
              { name: "id", in: "path", required: true, schema: { type: "string" } },
              { name: "expand", in: "query", required: false, schema: { type: "boolean" } },
            ],
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Order" },
                  },
                },
              },
            },
          },
          put: { responses: { "200": { description: "updated" } } },
        },
        "/orders": { post: { responses: { "201": { description: "created" } } } },
      },
      components: {
        schemas: {
          Order: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
      },
    });

    const result = diffOpenApiDocuments(document(), current);
    expect(result.ok).toBe(false);
    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "non-breaking", code: "parameter-added" }),
      expect.objectContaining({ kind: "non-breaking", code: "operation-added" }),
      expect.objectContaining({ kind: "non-breaking", code: "path-added" }),
      expect.objectContaining({ kind: "breaking", code: "response-property-removed" }),
      expect.objectContaining({ kind: "breaking", code: "response-property-optional" }),
    ]));
    expect(formatOpenApiDiff(result)).toContain("OpenAPI diff failed");
  });

  test("detects request tightening and accepts compatible additions", () => {
    const base = document({
      paths: {
        "/orders/{id}": {
          post: {
            requestBody: {
              required: false,
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/CreateOrder" } },
              },
            },
            responses: { "204": { description: "accepted" } },
          },
        },
      },
      components: {
        schemas: {
          CreateOrder: {
            type: "object",
            properties: { sku: { type: "string" } },
            required: [],
          },
        },
      },
    });
    const current = document({
      paths: {
        "/orders/{id}": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/CreateOrder" } },
              },
            },
            responses: { "204": { description: "accepted" }, "202": { description: "queued" } },
          },
        },
      },
      components: {
        schemas: {
          CreateOrder: {
            type: "object",
            properties: { sku: { type: "string" }, quantity: { type: "integer" } },
            required: ["quantity"],
          },
        },
      },
    });

    const result = diffOpenApiDocuments(base, current);
    expect(result).toMatchObject({ ok: false });
    expect(result.breaking).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "request-body-required" }),
      expect.objectContaining({ code: "request-property-required" }),
    ]));
    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "non-breaking", code: "response-added" }),
    ]));
  });

  test("reports removal of an existing request body", () => {
    const base = document({
      paths: {
        "/orders": {
          post: {
            requestBody: {
              required: true,
              content: { "application/json": { schema: { type: "object" } } },
            },
            responses: { "201": { description: "created" } },
          },
        },
      },
    });
    const current = document({
      paths: {
        "/orders": {
          post: { responses: { "201": { description: "created" } } },
        },
      },
    });

    const result = diffOpenApiDocuments(base, current);
    expect(result.breaking).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "request-body-removed", path: "paths./orders.post.requestBody" }),
    ]));
  });

  test("round-trips JSON and does not rewrite unchanged output", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-openapi-tools-"));
    try {
      const outputPath = join(root, "nested", "openapi.json");
      await expect(writeOpenApiJson(document(), outputPath)).resolves.toMatchObject({ written: true });
      await expect(writeOpenApiJson(document(), outputPath)).resolves.toMatchObject({ written: false });
      expect(await readOpenApiJson(outputPath)).toEqual(document());
      expect(await readFile(outputPath, "utf8")).toEndWith("\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("exports a generated runtime module without evaluating it in the compiler", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-openapi-export-"));
    try {
      const modulePath = join(root, "openapi.mjs");
      const outputPath = join(root, "openapi.json");
      await writeFile(modulePath, `export const OPENAPI_DOCUMENT = ${JSON.stringify(document())};\n`, "utf8");
      await expect(exportGeneratedOpenApiJson({ modulePath, outputPath })).resolves.toMatchObject({
        path: outputPath,
        written: true,
      });
      expect(await readOpenApiJson(outputPath)).toEqual(document());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("CLI exports a generated module as standalone JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-openapi-export-cli-"));
    try {
      const modulePath = join(root, "openapi.mjs");
      const outputPath = join(root, "nested", "openapi.json");
      await writeFile(modulePath, `export const OPENAPI_DOCUMENT = ${JSON.stringify(document())};\n`, "utf8");
      const child = Bun.spawn([
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "cli.ts"),
        "openapi-export",
        modulePath,
        outputPath,
        "--space",
        "0",
        "--json",
      ], { cwd: root, stdout: "pipe", stderr: "pipe" });
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(status).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, written: true, path: outputPath });
      expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(document());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects malformed documents without exposing parser details", async () => {
    await expect(readOpenApiJson(join(tmpdir(), "does-not-exist-openapi.json")))
      .rejects.toBeInstanceOf(OpenApiDocumentError);
    expect(() => diffOpenApiDocuments({ openapi: "2.0", info: {}, paths: {} }, document()))
      .toThrow(OpenApiDocumentError);
  });

  test("CLI emits a machine-readable failure for a breaking document change", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-openapi-cli-"));
    try {
      await writeFile(join(root, "base.json"), JSON.stringify(document()), "utf8");
      await writeFile(join(root, "current.json"), JSON.stringify(document({ paths: {} })), "utf8");
      const child = Bun.spawn([
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "cli.ts"),
        "openapi-diff",
        "base.json",
        "current.json",
        "--json",
      ], { cwd: root, stdout: "pipe", stderr: "pipe" });
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(status).toBe(1);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toMatchObject({
        ok: false,
        breaking: [expect.objectContaining({ code: "path-removed" })],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
