import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "@typescript/typescript6";
import { renderClient } from "./generate";
import type { ApplicationGraph } from "./types";
import { writeFixtureProject } from "./fixtures/helpers";
import { createQueryAdapter } from "../../query/src/index.js";

const graph: ApplicationGraph = {
  externalTokens: [],
  modules: [{
    name: "items", className: "ItemsModule", file: "items.ts", line: 1,
    imports: [], providers: [], queries: [], exports: [],
    commands: [{ className: "Save", name: "item.save", permission: "save", transaction: "required", idempotency: "required" }],
    controllers: [{
      className: "ItemsController", path: "/tenants/:tenant/items", scope: "request",
      deps: [], file: "items.ts", importPath: "./items",
      schemaImports: { Result: "./schemas" },
      routes: [
        { method: "GET", path: "/:id", handler: "get", response: "Result" },
        { method: "POST", path: "/:id", handler: "save", command: "Save", response: "Result" },
      ],
    }],
  }],
};

test("grouped procedures preserve main runtime hooks, metadata and required execution types", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-procedure-group-"));
  try {
    await writeFixtureProject(root, {
      "client.ts": renderClient(graph, { rootDir: root, outDir: root }),
      "schemas.ts": 'export const Result = { type: "object", properties: { id: { type: "string" } }, required: ["id"] } as const;',
      "consumer.ts": [
        'import { createApiClient, createProcedureClient } from "./client";',
        `import { createQueryAdapter } from ${JSON.stringify(join(import.meta.dir, "../../query/src/index"))};`,
        "const client = createApiClient();",
        "const group = createProcedureClient(client);",
        'const input = { params: { tenant: "t", id: "1" } };',
        "const value: Promise<{ id: string }> = group.items.get.query(input);",
        "// @ts-expect-error Missing inherited path parameter.",
        'group.items.get.query({ params: { id: "1" } });',
        "// @ts-expect-error Missing explicit execution key.",
        "group.items.save.mutate(input);",
        'const adapter = createQueryAdapter(client, { keyPrefix: ["tenant", "actor"] });',
        "adapter.items.get.queryOptions(input);",
        "const adapted: Promise<{ id: string }> = adapter.items.get.queryOptions(input).queryFn({});",
        "// @ts-expect-error Response types cannot be fabricated.",
        "const wrong: Promise<number> = adapter.items.get.queryOptions(input).queryFn({});",
        "// @ts-expect-error Missing required input.",
        "adapter.items.get.queryOptions();",
        "// @ts-expect-error Queries do not expose mutations.",
        "adapter.items.get.mutationOptions();",
        "// @ts-expect-error Adapter must preserve required execution key.",
        "adapter.items.save.mutationOptions().mutationFn({ input });",
        'adapter.items.save.mutationOptions().mutationFn({ input, execution: { idempotencyKey: "attempt-1" } });',
        "const metadata: readonly unknown[] = client.procedures;",
      ].join("\n"),
    });
    const program = ts.createProgram([join(root, "consumer.ts")], {
      strict: true, noEmit: true, skipLibCheck: true, types: [],
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      paths: { typebox: [join(import.meta.dir, "../node_modules/typebox")] },
    });
    expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
    const generated = await import(pathToFileURL(join(root, "client.ts")).href);
    const requests: { url: string; key: string | null }[] = [];
    let validations = 0;
    const client = generated.createApiClient({
      baseUrl: "https://example.test",
      procedureExecutionValidator: () => { validations++; },
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), key: new Headers(init?.headers).get("idempotency-key") });
        return Response.json({ id: "1" });
      },
    });
    expect(client.procedures).toBe(generated.API_PROCEDURES);
    expect(client.procedureClient.items.get.query).toBe(client.items.get.query);
    expect(generated.createProcedureClient(client)).toBe(client.procedureClient);
    const input = { params: { tenant: "t", id: "1" }, query: { fields: "id" } };
    await client.procedureClient.items.get.query(input);
    await expect(client.procedureClient.items.save.mutate(input)).rejects.toThrow("idempotencyKey");
    await client.procedureClient.items.save.mutate(input, { idempotencyKey: "attempt-1" });
    expect(requests).toEqual([
      { url: "https://example.test/tenants/t/items/1?fields=id", key: null },
      { url: "https://example.test/tenants/t/items/1?fields=id", key: "attempt-1" },
    ]);
    expect(validations).toBe(3);
    const adapter = createQueryAdapter(client, { keyPrefix: ["t", "actor"] });
    expect(await adapter.items.get.queryOptions(input).queryFn({})).toEqual({ id: "1" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
