import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanGeneratedArtifacts, scanProductionSource } from "./type-safety";
import { writeFixtureProject } from "./fixtures/helpers";

describe("compiler type-safety gates", () => {
  test("strict generated-artifact scan rejects any", () => {
    const diagnostics = scanGeneratedArtifacts({
      "application.ts": "export function create(value: any): unknown { return value; }\n",
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      severity: "error",
      code: "generated-any",
      errorCode: "SC6001",
      file: "application.ts",
      line: 1,
    });
  });

  test("production scan reports any, assertions, non-null assertions and widening", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "supacloud-compiler-type-safety-"));
    await writeFixtureProject(rootDir, {
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
      "src/production.ts": [
        "export const unsafe: any = 1;",
        "export const asserted = unsafe as number;",
        "export const required = unsafe!;",
        "export let widened = 'mutable';",
      ].join("\n"),
      "src/ignored.test.ts": "export const ignored: any = 1;",
      "src/ignored.ts": "export const ignored: any = 1;",
    });

    const diagnostics = scanProductionSource({
      rootDir,
      exclude: ["src/ignored.ts"],
      strict: true,
    });

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "source-any",
      "source-type-assertion",
      "source-non-null-assertion",
      "source-implicit-widening",
    ]);
    expect(diagnostics.every((diagnostic) => diagnostic.severity === "error")).toBe(true);
    expect(diagnostics.every((diagnostic) => diagnostic.file === "src/production.ts")).toBe(true);
  });

  test("as const and excluded test files are accepted", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "supacloud-compiler-type-safety-"));
    await writeFixtureProject(rootDir, {
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
      "src/production.ts": [
        'export const stable = { mode: "strict" } as const;',
        "export const typed: { mode: string } = { mode: 'strict' };",
      ].join("\n"),
      "src/production.test.ts": "export const ignored: any = 1;",
    });

    expect(scanProductionSource({ rootDir, strict: true })).toEqual([]);
  });
});
