import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeProject } from "./analyze";
import { compileProject } from "./compile";
import { validateGraph } from "./validate";
import { GOOD_PROJECT_FILES } from "./fixtures/good-project";
import { writeFixtureProject } from "./fixtures/helpers";
import type { ApplicationGraph, RouteNode } from "./types";
import { renderClient, renderOpenApi } from "./generate";

function graphWith(route: RouteNode): ApplicationGraph {
  return {
    externalTokens: [], modules: [{
      name: "body", className: "BodyModule", file: "body.ts", line: 1,
      imports: [], providers: [], commands: [], queries: [], exports: [],
      controllers: [{
        className: "BodyController", path: "/", scope: "application", deps: [],
        file: "body.ts", importPath: "./body", routes: [route],
      }],
    }],
  };
}

test("DELETE body compatibility is explicit and does not relax safe methods", () => {
  const base: RouteNode = { method: "DELETE", path: "/", handler: "remove", body: "Body", hasBodyBinding: true };
  expect(validateGraph(graphWith(base))).toContainEqual(expect.objectContaining({ code: "disallowed-body-on-get-delete" }));
  expect(validateGraph(graphWith({ ...base, allowDeleteBody: true })).filter(d => d.severity === "error")).toEqual([]);
  for (const method of ["GET", "HEAD", "OPTIONS", "POST"] as const) {
    expect(validateGraph(graphWith({ ...base, method, allowDeleteBody: true })))
      .toContainEqual(expect.objectContaining({ code: "invalid-delete-body-opt-in" }));
  }
  expect(validateGraph(graphWith({ ...base, body: undefined, allowDeleteBody: true })))
    .toContainEqual(expect.objectContaining({ code: "invalid-delete-body-opt-in" }));
});

test("raw parsing requires evidenced domain ownership and cannot bind a parsed body", () => {
  const raw: RouteNode = {
    method: "POST", path: "/", handler: "raw", parse: "none",
    contract: { body: "domain", evidence: "signature.test.ts" },
  };
  expect(validateGraph(graphWith(raw)).filter(d => d.severity === "error")).toEqual([]);
  for (const change of [{ body: "Body" }, { hasBodyBinding: true }, { contract: undefined }, { contract: { body: "domain" as const, evidence: " " } }]) {
    expect(validateGraph(graphWith({ ...raw, ...change })))
      .toContainEqual(expect.objectContaining({ code: "invalid-raw-body-contract" }));
  }
});

test("raw parsing survives AST analysis and generated descriptors; invalid literals fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-body-policy-"));
  try {
    const source = GOOD_PROJECT_FILES["src/features/case/case.controller.ts"]
      .replace("body: CreateCaseBody,", 'parse: "none", contract: { body: "domain", evidence: "signature.test.ts" },');
    await writeFixtureProject(root, { ...GOOD_PROJECT_FILES, "src/features/case/case.controller.ts": source });
    const result = await compileProject({ rootDir: root, outDir: join(root, "generated") });
    expect(result.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    expect(await readFile(join(root, "generated/application.ts"), "utf8")).toContain('parse: "none"');
    for (const replacement of ['parse: "json"', "parse: parser", "allowDeleteBody: false"]) {
      await writeFixtureProject(root, {
        "src/features/case/case.controller.ts": source.replace('parse: "none"', replacement),
      });
      const analyzed = await analyzeProject(root);
      expect(analyzed.diagnostics).toContainEqual(expect.objectContaining({
        severity: "error", code: replacement.startsWith("parse") ? "invalid-route-parser" : "invalid-delete-body-opt-in",
      }));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("static spreads preserve body policies in property order and dynamic spreads fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-body-spreads-"));
  try {
    const base = GOOD_PROJECT_FILES["src/features/case/case.controller.ts"];
    for (const [policy, expected] of [
      ['...{ parse: "none" }', "none"],
      ['parse: "json", ...{ parse: "none" }', "none"],
      ['...{ parse: "none" }, parse: "json"', "invalid-route-parser"],
      ["...runtimePolicy", "unresolved-route-body-policy"],
    ]) {
      await writeFixtureProject(root, {
        ...GOOD_PROJECT_FILES,
        "src/features/case/case.controller.ts": base.replace("body: CreateCaseBody,", `${policy}, contract: { body: "domain", evidence: "raw.test.ts" },`),
      });
      const graph = await analyzeProject(root);
      if (expected === "none") {
        expect(graph.modules.find(m => m.name === "case")?.controllers[0]?.routes[0]?.parse).toBe("none");
      } else {
        expect(graph.diagnostics).toContainEqual(expect.objectContaining({ code: expected, severity: "error" }));
      }
    }
    await writeFixtureProject(root, {
      ...GOOD_PROJECT_FILES,
      "src/features/case/case.controller.ts": base.replaceAll("Post", "Delete")
        .replace("body: CreateCaseBody,", "body: CreateCaseBody, allowDeleteBody: true,"),
    });
    const result = await compileProject({ rootDir: root, outDir: join(root, "generated") });
    expect(result.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    expect(await readFile(join(root, "generated/application.ts"), "utf8")).toContain("allowDeleteBody: true");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("raw client sends bytes and streams without JSON encoding and documents raw ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-raw-client-"));
  const graph = graphWith({
    method: "POST", path: "raw", handler: "raw", parse: "none",
    contract: { body: "domain", response: "binary", evidence: "raw.test.ts" },
  });
  try {
    await writeFixtureProject(root, {
      "client.ts": renderClient(graph, { rootDir: root, outDir: root }),
      "openapi.ts": renderOpenApi(graph, { rootDir: root, outDir: root }),
    });
    const generated = await import(pathToFileURL(join(root, "client.ts")).href);
    const sent: RequestInit[] = [];
    const client = generated.createApiClient({
      fetch: async (_url: string, init: RequestInit) => { sent.push(init); return new Response("ok"); },
    });
    const bytes = new Uint8Array([0, 123, 255, 10]);
    await client.body.raw({ body: bytes });
    expect(sent[0]?.body).toBe(bytes);
    expect(new Headers(sent[0]?.headers).has("content-type")).toBe(false);
    const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    await client.body.raw({ body: stream, headers: { "content-type": "application/octet-stream" } });
    expect(sent[1]?.body).toBe(stream);
    await expect(client.body.raw({ body: { invalid: true } })).rejects.toThrow("BodyInit");
    expect(generated.API_ROUTES[0].parse).toBe("none");
    const document = (await import(pathToFileURL(join(root, "openapi.ts")).href)).createOpenApiDocument();
    expect(document.paths["/raw"].post.requestBody.content["*/*"].schema.format).toBe("binary");
    expect(document.paths["/raw"].post["x-supacloud"].parse).toBe("none");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
