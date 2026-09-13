import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "@typescript/typescript6";
import { renderClient } from "./generate";
import type { ApplicationGraph } from "./types";
import { writeFixtureProject } from "./fixtures/helpers";

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
