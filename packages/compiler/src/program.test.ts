import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as ts from "@typescript/typescript6";
import { createIncrementalProgramSession } from "./program";
import { GOOD_PROJECT_FILES } from "./fixtures/good-project";
import { writeFixtureProject } from "./fixtures/helpers";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(files: Record<string, string>): Promise<string> {
  const rootDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "supacloud-program-"));
  roots.push(rootDir);
  await writeFixtureProject(rootDir, files);
  return rootDir;
}

describe("IncrementalProgramSession", () => {
  test("复用未变更 SourceFile，并只重编译发生变化文件的 traits", async () => {
    const rootDir = await fixture(GOOD_PROJECT_FILES);
    const session = createIncrementalProgramSession(rootDir);
    const files = [
      join(rootDir, "src/features/audit/audit.module.ts"),
      join(rootDir, "src/features/case/case.service.ts"),
      join(rootDir, "src/features/health/health.module.ts"),
    ];

    const first = session.update(files);
    const auditBefore = first.program.getSourceFile(files[0]);
    const caseBefore = first.program.getSourceFile(files[1]);
    expect(session.getTraits().some((trait) => trait.kind === "module" && trait.name === "AuditModule")).toBe(true);
    expect(session.getTraits().some((trait) => trait.kind === "defineModule" && trait.name === "HealthModule")).toBe(true);
    expect(session.getTraits().some((trait) => trait.kind === "injectionToken")).toBe(true);

    await appendFile(join(rootDir, "src/features/audit/audit.module.ts"), "\n// changed\n", "utf8");
    const second = session.update(files, ["src/features/audit/audit.module.ts"]);
    expect(second.reusedFiles).toContain(files[1]);
    expect(second.changedFiles).toContain(files[0]);
    expect(second.program.getSourceFile(files[1]) === caseBefore).toBe(true);
    expect(second.program.getSourceFile(files[0])?.text).not.toBe(auditBefore?.text);
  });

  test("refreshes imported files even when the change hints omit them", async () => {
    const root = await fixture({
      "src/main.ts": 'export { value } from "./dependency";\n',
      "src/dependency.ts": "export const value = 1;\n",
    });
    const session = createIncrementalProgramSession(root);
    const dependency = join(root, "src/dependency.ts");
    const files = [join(root, "src/main.ts"), dependency];
    session.update(files);
    await writeFile(dependency, "export const value = 2;\n");
    const updated = session.update(files, []);
    expect(updated.program.getSourceFile(dependency)?.text).toContain("value = 2");
    expect(updated.changedFiles).toContain(dependency);
  });

  test("reloads inherited compiler options without requiring a new session", async () => {
    const root = await fixture({
      "tsconfig.json": '{"extends":"./base.json","include":["src"]}',
      "base.json": '{"compilerOptions":{"target":"ES2022","module":"ESNext"}}',
      "src/main.ts": "export const value = 1;\n",
    });
    const session = createIncrementalProgramSession(root);
    const file = join(root, "src/main.ts");
    const first = session.update([file]);
    expect(first.program.getCompilerOptions().target).toBe(ts.ScriptTarget.ES2022);
    await writeFile(join(root, "base.json"), '{"compilerOptions":{"target":"ES5","module":"ESNext"}}');
    const next = session.update([file], ["base.json"]);
    expect(next.program.getCompilerOptions().target).toBe(ts.ScriptTarget.ES5);
    expect(next.program.getSourceFile(file)?.languageVersion).toBe(ts.ScriptTarget.ES5);
  });

  test("invalidates missing-file caches on import creation, deletion and recreation", async () => {
    const root = await fixture({
      "src/main.ts": 'export { value } from "./dependency";\n',
    });
    const session = createIncrementalProgramSession(root);
    const files = [join(root, "src/main.ts")];
    const dependency = join(root, "src/dependency.ts");
    session.update(files);
    await writeFile(dependency, "export const value = 1;\n");
    expect(session.update(files, [dependency]).program.getSourceFile(dependency)?.text).toContain("value = 1");
    await rm(dependency);
    const removed = session.update(files, [dependency]);
    expect(removed.program.getSourceFile(dependency)).toBeUndefined();
    expect(removed.changedFiles).toContain(dependency);
    await writeFile(dependency, "export const value = 2;\n");
    expect(session.update(files, [dependency]).program.getSourceFile(dependency)?.text).toContain("value = 2");
  });

  test("retains the builder emit state for unaffected files", async () => {
    const root = await fixture({
      "tsconfig.json": '{"compilerOptions":{"target":"ES2022","module":"ESNext","outDir":"dist"},"include":["src"]}',
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 1;\n",
    });
    const session = createIncrementalProgramSession(root);
    const files = [join(root, "src/a.ts"), join(root, "src/b.ts")];
    session.update(files);
    expect(session.emit().emitSkipped).toBe(false);
    const output = join(root, "dist/b.js");
    await writeFile(output, "// unchanged output\n");
    await writeFile(files[0], "export const a = 2;\n");
    session.update(files, [files[0]]);
    expect(session.emit().emitSkipped).toBe(false);
    expect(await readFile(join(root, "dist/a.js"), "utf8")).toContain("a = 2");
    expect(await readFile(output, "utf8")).toBe("// unchanged output\n");
    session.reset();
    session.update(files);
    session.emit();
    expect(await readFile(output, "utf8")).toContain("b = 1");
  });
});
