import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compileProject } from "./compile";
import { GOOD_PROJECT_FILES } from "./fixtures/good-project";
import { writeFixtureProject } from "./fixtures/helpers";

test("hidden documentation retains the runtime descriptor, manifest and client", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-hidden-route-"));
  try {
    const source = GOOD_PROJECT_FILES["src/features/case/case.controller.ts"]
      .replace("body: CreateCaseBody,", "body: CreateCaseBody, data: { openapi: { hide: true } },");
    await writeFixtureProject(root, { ...GOOD_PROJECT_FILES, "src/features/case/case.controller.ts": source });
    const outDir = join(root, "generated");
    const result = await compileProject({ rootDir: root, outDir, generateClient: true, generateOpenApi: true });
    expect(result.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    const api = await import(pathToFileURL(join(outDir, "openapi.ts")).href);
    expect(api.createOpenApiDocument().paths["/cases/{caseId}/accept"]).toBeUndefined();
    expect(await Bun.file(join(outDir, "application.ts")).text()).toContain('"hide":true');
    const manifest = await Bun.file(join(outDir, "contracts.manifest.json")).json();
    expect(manifest.routes.some((route: { path: string }) => route.path === "/cases/:caseId/accept")).toBe(true);
    expect(await Bun.file(join(outDir, "client.ts")).text()).toContain("/cases/:caseId/accept");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
