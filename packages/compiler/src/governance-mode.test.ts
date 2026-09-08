import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileProject } from "./compile";
import { applyDiagnosticFix } from "./fixes";
import { writeFixtureProject } from "./fixtures/helpers";
import { RUNTIME_SOURCE } from "./fixtures/runtime-source";
import type { DiagnosticFix } from "./types";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const source = (mode: string, standalone = false) => `
import { Command, Module } from "./runtime";
@Command({ name: "case.approve", permission: "case.approve", transaction: ${mode}, idempotency: "required", standalone: ${standalone} })
export class Approve {}
@Module({ name: "case", commands: ${standalone ? "[]" : "[Approve]"} })
export class CaseModule {}
`;
test("invalid governance fails closed, preserves artifacts and repairs through explicit semantic fixes", async () => {
  const root = await mkdtemp(join(tmpdir(), "command-mode-"));
  roots.push(root);
  const outDir = join(root, "generated");
  await writeFixtureProject(root, {
    "tsconfig.json": JSON.stringify({ compilerOptions: { experimentalDecorators: true }, include: ["src/**/*.ts"] }),
    "src/runtime.ts": RUNTIME_SOURCE,
    "src/case.module.ts": source('"required"'),
  });
  const good = await compileProject({ rootDir: root, outDir });
  expect(good.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  const artifact = await readFile(join(outDir, "application.ts"), "utf8");
  for (const mode of ['"requried"', "true", '("required")', 'process.env.POLICY']) {
    await writeFixtureProject(root, { "src/case.module.ts": source(mode) });
    const result = await compileProject({ rootDir: root, outDir });
    const diagnostic = result.diagnostics.find((item) => item.code === "invalid-command-mode");
    expect(diagnostic?.errorCode).toBe("SC4012");
    expect(await readFile(join(outDir, "application.ts"), "utf8")).toBe(artifact);
    const fix: DiagnosticFix = JSON.parse(JSON.stringify(diagnostic?.fix));
    if (fix.type !== "set_command_mode") throw new Error("Expected command mode fix");
    await expect(applyDiagnosticFix(fix, { rootDir: root })).rejects.toThrow("explicit");
    const chosen = { ...fix, value: "required" as const };
    const preview = await applyDiagnosticFix(chosen, { rootDir: root });
    expect(preview.changed).toBe(true);
    expect(await readFile(join(root, "src/case.module.ts"), "utf8")).toContain(mode);
    await applyDiagnosticFix(chosen, { rootDir: root, dryRun: false });
    await expect(applyDiagnosticFix(chosen, { rootDir: root, dryRun: false })).rejects.toThrow("changed");
    const repaired = await compileProject({ rootDir: root, outDir });
    expect(repaired.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  }
});

test("standalone command declarations receive the same governance diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "command-mode-standalone-"));
  roots.push(root);
  await writeFixtureProject(root, {
    "tsconfig.json": JSON.stringify({ compilerOptions: { experimentalDecorators: true } }),
    "src/runtime.ts": RUNTIME_SOURCE,
    "src/case.module.ts": source('"typo"', true),
  });
  const result = await compileProject({ rootDir: root, outDir: join(root, "generated") });
  expect(result.diagnostics.some((item) => item.code === "invalid-command-mode")).toBe(true);
});
