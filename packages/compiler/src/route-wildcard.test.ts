import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compileProject } from "./compile";
import { GOOD_PROJECT_FILES } from "./fixtures/good-project";
import { writeFixtureProject } from "./fixtures/helpers";
import { renderClient, renderOpenApi } from "./generate";

test("terminal wildcards compile as named bindings and retain segments in generated clients", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-wildcard-"));
  try {
    const source = GOOD_PROJECT_FILES["src/features/case/case.controller.ts"]
      .replace('@Controller("/cases")', 'const Param = (_name: string): ParameterDecorator => () => {};\n@Controller("/cases")')
      .replace('"/:caseId/accept"', '"/:caseId/files/*"')
      .replace("accept():", 'accept(@Param("*") key: string):');
    await writeFixtureProject(root, { ...GOOD_PROJECT_FILES, "src/features/case/case.controller.ts": source });
    const options = { rootDir: root, outDir: join(root, "generated") };
    const compiled = await compileProject(options);
    expect(compiled.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    const route = compiled.graph.modules.find(module => module.name === "case")!.controllers[0]!.routes[0]!;
    expect(route.pathParams).toEqual(["caseId", "*"]);
    await writeFixtureProject(root, {
      "generated/client.ts": renderClient(compiled.graph, options),
      "generated/openapi.ts": renderOpenApi(compiled.graph, options),
    });
    const client = await import(pathToFileURL(join(root, "generated/client.ts")).href);
    expect(client.buildRouteUrl("/cases/:caseId/files/*", { caseId: "a", "*": "nested/a b/中文.txt" }))
      .toBe("/cases/a/files/nested/a%20b/%E4%B8%AD%E6%96%87.txt");
    expect(() => client.buildRouteUrl("/cases/:caseId/files/*", { caseId: "a" })).toThrow("Missing route parameter: *");
    expect(client.buildRouteUrl("/cases/:caseId/files/*", { caseId: "a", "*": "" })).toBe("/cases/a/files/");
    for (const key of [".", "..", "nested/../outside", "nested/./file"]) {
      expect(() => client.buildRouteUrl("/cases/:caseId/files/*", { caseId: "a", "*": key })).toThrow("dot segments");
    }
    const encodedDot = client.buildRouteUrl("/cases/:caseId/files/*", { caseId: "a", "*": "%2e%2e/file" });
    expect(new Request(`https://example.test${encodedDot}`).url).toEndWith("/files/%252e%252e/file");
    const api = (await import(pathToFileURL(join(root, "generated/openapi.ts")).href)).createOpenApiDocument();
    expect(api.paths["/cases/{caseId}/files/{wildcard}"].post.parameters)
      .toContainEqual(expect.objectContaining({ name: "wildcard", in: "path", required: true }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wildcard and named parameter OpenAPI collisions fail before emission", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-wildcard-conflict-"));
  try {
    const source = GOOD_PROJECT_FILES["src/features/case/case.controller.ts"]
      .replace('"/:caseId/accept"', '"/files/*"')
      .replace("  accept()", '  other() {}\n  @Post("/files/:wildcard", { response: AcceptResult })\n  accept()');
    await writeFixtureProject(root, { ...GOOD_PROJECT_FILES, "src/features/case/case.controller.ts": source });
    const compiled = await compileProject({ rootDir: root, outDir: join(root, "generated"), generateOpenApi: true });
    expect(compiled.diagnostics.some(d => d.errorCode === "SC3007" && d.severity === "error"), JSON.stringify(compiled.diagnostics)).toBe(true);
    expect(await Bun.file(join(root, "generated/openapi.ts")).exists()).toBe(false);
    const runtimeOnly = await compileProject({ rootDir: root, outDir: join(root, "generated"), generateOpenApi: false });
    expect(runtimeOnly.diagnostics.filter(d => d.severity === "error")).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
