import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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
      "source-any",
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

  test("typed destructuring does not become any, but unsafe binding leaves are reported", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "supacloud-compiler-type-safety-"));
    await writeFixtureProject(rootDir, {
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
      "src/production.ts": [
        "declare const input: { value: string; nested: { count: number }; unsafe: any };",
        "export const { value, nested: { count } } = input;",
        "export const [first, ...rest] = [1, 2];",
        "export const { unsafe: alias } = input;",
        "export const handler: (input: { value: string }) => string = ({ value }) => value;",
      ].join("\n"),
    });
    const diagnostics = scanProductionSource({ rootDir, strict: true });
    expect(diagnostics.map(({ code, line }) => ({ code, line }))).toEqual([
      { code: "source-any", line: 1 },
      { code: "source-any", line: 4 },
    ]);
  });

  test("project types resolve from the scanned package instead of the caller cwd", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "supacloud-compiler-type-safety-"));
    await writeFixtureProject(rootDir, {
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, types: ["scan-env"] } }),
      "node_modules/@types/scan-env/index.d.ts": "declare function scanEnvValue(): string;",
      "src/production.ts": "export const value = scanEnvValue();",
    });
    expect(scanProductionSource({ rootDir, strict: true })).toEqual([]);
    expect(scanProductionSource({ rootDir: relative(process.cwd(), rootDir), strict: true })).toEqual([]);
  });

  test("default exclusions work at root and nested levels without excluding production lookalikes", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "supacloud-compiler-type-safety-"));
    const ignored = [
      "root.test.ts", "root.spec.ts", "nested/file.test.ts", "__tests__/helper.ts",
      "fixtures/input.ts", "generated/app.ts", "nested/fixtures/input.ts", "types.d.ts",
    ];
    await writeFixtureProject(rootDir, {
      ...Object.fromEntries(ignored.map((file) => [file, "export const unsafe: any = 1;"])),
      "src/test-utils.ts": "export const unsafe: any = 1;",
    });
    const diagnostics = scanProductionSource({ rootDir, strict: true });
    expect(diagnostics.map(({ file, code }) => ({ file, code }))).toEqual([
      { file: "src/test-utils.ts", code: "source-any" },
    ]);
  });

  test("invalid configuration and missing type libraries cannot pass silently", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "supacloud-compiler-type-safety-"));
    await writeFixtureProject(rootDir, {
      "tsconfig.json": JSON.stringify({ compilerOptions: { types: ["missing-env"], invalidOption: true } }),
      "src/production.ts": "export const value = 1;",
    });
    const diagnostics = scanProductionSource({ rootDir });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", code: "source-config", errorCode: "TS5023" }),
      expect.objectContaining({ severity: "error", code: "source-config", errorCode: "TS2688" }),
    ]));
  });
});
