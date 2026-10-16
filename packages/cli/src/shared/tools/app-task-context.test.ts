import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeAppProject } from "./app-starter";
import { runAppTool } from "./app-tools";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("target context connects maintained files, dependencies, preview repairs and bounded verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-context-"));
  roots.push(root);
  await initializeAppProject({ root, name: "sample" });
  const repo = resolve(import.meta.dir, "../../../../..");
  await symlink(join(repo, "packages/cli/node_modules"), join(root, "node_modules"), "dir");
  const config = JSON.parse(await readFile(join(root, "tsconfig.json"), "utf8"));
  config.compilerOptions.paths = { "@supacloud/app/core": [join(repo, "packages/app/src/core.ts")] };
  await writeFile(join(root, "tsconfig.json"), JSON.stringify(config));
  const generated = await readFile(join(root, "generated/application.ts"), "utf8");
  const result = await runAppTool({ action: "context", root, target: "health", format: "json" });
  const pack = JSON.parse(result.content[0]!.text);
  expect(pack.subject).toBe("health");
  expect(pack.workflow.editFiles).toContain("src/features/health/health.ts");
  expect(pack.workflow.verification.tests).toEqual(["src/features/health/health.test.ts"]);
  expect(pack.workflow.allowedDependencies.dependencies).toContain("@supacloud/js");
  expect(pack.workflow.rules.permissions).toBe("explicit-business-input-required");
  expect(pack.workflow.rules.fixDefault).toBe("preview");
  expect(pack.workflow.release.first).toEqual(["supacloud", "app", "check", "--format", "json"]);
  expect(pack.workflow.executed).toBe(false);
  const doctor = await runAppTool({ action: "doctor", root, target: "health", format: "json" });
  const diagnosis = JSON.parse(doctor.content[0]!.text);
  expect(diagnosis.scope.target).toBe("health");
  expect(diagnosis.scope.generatedArtifactCheck).toBe("project-wide");
  expect(diagnosis.scope.notChecked).toContain("unwired contracts outside graph");
  expect(await readFile(join(root, "generated/application.ts"), "utf8")).toBe(generated);
}, 30_000);
