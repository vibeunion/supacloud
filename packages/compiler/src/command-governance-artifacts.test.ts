import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProject, compileProject } from "./compile";
import { writeFixtureProject } from "./fixtures/helpers";

const validSource = `
import { Command, Module } from "@supacloud/app";
@Command({ name: "case.update", permission: "case:update", transaction: "required",
  idempotency: "required", audit: "case.updated" })
export class UpdateCase {}
@Module({ name: "case", commands: [UpdateCase] })
export class CaseModule {}
`;

// Both files describe the same application. A failed default-policy check must
// not leave new governance metadata paired with an older executable factory.
test("implicit governance defaults preserve both factories and manifest on failure and recover after repair", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-default-artifacts-"));
  try {
    await writeFixtureProject(root, {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { experimentalDecorators: true }, include: ["src/**/*.ts"],
      }),
      "src/case.module.ts": validSource,
    });
    const options = { rootDir: root, outDir: join(root, "generated") };
    // Intentionally omit commandCapabilities: this exercises the public default.
    const good = await compileProject(options);
    expect(good.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect((await checkProject(options)).upToDate).toBe(true);
    const artifacts = ["application.ts", "app.manifest.json"];
    const snapshot = async () => Promise.all(artifacts.map((name) =>
      readFile(join(options.outDir, name), "utf8")));
    const before = await snapshot();

    await writeFixtureProject(root, {
      "src/case.module.ts": validSource.replace(', audit: "case.updated"', ""),
    });
    const failed = await compileProject(options);
    expect(failed.diagnostics).toContainEqual(expect.objectContaining({
      code: "command-persistence-required", errorCode: "SC4020", severity: "error",
    }));
    expect(failed.written).toEqual([]);
    expect(await snapshot()).toEqual(before);

    const checked = await checkProject(options);
    expect(checked.diagnostics).toContainEqual(expect.objectContaining({
      code: "command-persistence-required", errorCode: "SC4020", severity: "error",
    }));
    expect(await snapshot()).toEqual(before);

    await writeFixtureProject(root, { "src/case.module.ts": validSource });
    const repaired = await compileProject(options);
    expect(repaired.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    const rechecked = await checkProject(options);
    expect(rechecked.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(rechecked.upToDate).toBe(true);
    expect(await snapshot()).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
