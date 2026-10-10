import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { scanGeneratedArtifacts, scanProductionSource } from "./type-safety";
import { writeFixtureProject } from "./fixtures/helpers";
import { compileProject, checkProject } from "./compile";
import { createIncrementalCompiler } from "./incremental";

const temporaryProjects: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function projectFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "supacloud-strict-types-"));
  temporaryProjects.push(root);
  await writeFixtureProject(root, files);
  return root;
}

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

  test("any remains a hard error when other strict diagnostics are disabled", async () => {
    const rootDir = await projectFixture({
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
      "src/production.ts": "export const unsafe: any = 1;",
    });

    const diagnostics = scanProductionSource({ rootDir, strict: false });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "source-any",
        errorCode: "SC6002",
      }),
    ]);
    expect(scanGeneratedArtifacts({ "application.ts": "export const value: any = 1;" }, false)).toEqual([
      expect.objectContaining({ severity: "error", code: "generated-any" }),
    ]);
  });

  test.each([
    ["noImplicitAny", "export function echo(value) { return value; }", "TS7006"],
    ["strictNullChecks", "export const value: string = null;", "TS2322"],
    ["strictFunctionTypes", "export const handler: (value: string | number) => void = (value: string) => {};", "TS2322"],
    ["strictBindCallApply", 'function echo(value: number) { return value; }\nexport const value = echo.call(null, "wrong");', "TS2345"],
    ["strictPropertyInitialization", "export class Value { value: string; }", "TS2564"],
    ["noImplicitThis", "export function read() { return this.value; }", "TS2683"],
    ["useUnknownInCatchVariables", 'try { throw 1; } catch (error) { error.message; }\nexport {};', "TS18046"],
    ["strictBuiltinIteratorReturn", "export const value: number = new Set<number>().values().next().value;", "TS2322"],
    ["noUncheckedIndexedAccess", "export const values: string[] = [];\nexport const value: string = values[0];", "TS2322"],
    ["exactOptionalPropertyTypes", "export const value: { name?: string } = { name: undefined };", "TS2375"],
    ["noImplicitOverride", "class Base { value() {} }\nexport class Derived extends Base { value() {} }", "TS4114"],
    ["noPropertyAccessFromIndexSignature", "export const values: Record<string, number> = {};\nexport const value = values.item;", "TS4111"],
    ["noFallthroughCasesInSwitch", "export function run(value: number) { switch (value) { case 0: value += 1; case 1: break; } }", "TS7029"],
  ])("enforces %s even when the project disables it and strict diagnostics", async (option, source, errorCode) => {
    const rootDir = await projectFixture({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: false, [option]: false, target: "ES2022", types: [] },
      }),
      "src/production.ts": source,
    });
    expect(scanProductionSource({ rootDir, strict: false })).toContainEqual(
      expect.objectContaining({ severity: "error", code: "source-typescript", errorCode }),
    );
  });

  test("safe unknown narrowing, optional omission, indexed access and override remain accepted", async () => {
    const rootDir = await projectFixture({
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: false, types: [], target: "ES2022" } }),
      "src/production.ts": [
        "export function decode(value: unknown): string {",
        '  if (typeof value !== "string") throw new Error("Invalid input");',
        "  return value;",
        "}",
        "export const optional: { name?: string } = {};",
        "export const values: Record<string, number> = {};",
        'export const value: number = values["item"] ?? 0;',
        "class Base { value(): number { return 1; } }",
        "export class Derived extends Base { override value(): number { return 2; } }",
      ].join("\n"),
    });
    expect(scanProductionSource({ rootDir, strict: true })).toEqual([]);
  });

  test.each([
    ["export const value: any = 1;", "source-any"],
    ["export const value: string = null;", "source-typescript"],
  ])("compile and check cannot disable type gates for %s", async (source, code) => {
    const lastGood = "// last good application\n";
    const rootDir = await projectFixture({
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: false, types: [] } }),
      "src/production.ts": source,
      "generated/application.ts": lastGood,
    });
    const options = {
      rootDir: join(rootDir, "src"),
      outDir: join(rootDir, "generated"),
      strict: false,
      writeOnError: true,
      typeSafety: { scanProductionSource: false, noAnyInGenerated: false },
    };
    const compiled = await compileProject(options);
    const checked = await checkProject(options);
    for (const result of [compiled, checked]) {
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code, severity: "error" }));
    }
    expect(compiled.written).toEqual([]);
    expect(await readFile(join(rootDir, "generated/application.ts"), "utf8")).toBe(lastGood);
  });

  test.each(["explicit", "default"] as const)("incremental %s compilation rechecks imported declarations outside the watched root", async (mode) => {
    const root = await projectFixture({
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: false, types: [] } }),
      "external.d.ts": "export declare const input: string;",
      "src/production.ts": 'import { input } from "../external";\nexport const value: string = input;',
    });
    const options = {
      rootDir: join(root, "src"),
      outDir: join(root, "generated"),
      ...(mode === "explicit" ? { strict: false, typeSafety: { scanProductionSource: false } } : {}),
    };
    const incremental = createIncrementalCompiler();
    const first = await incremental.compile(options);
    expect(first.diagnostics.filter(({ code }) => code.startsWith("source-"))).toEqual([]);
    await writeFixtureProject(root, { "external.d.ts": "export declare const input: string | null;" });
    const second = await incremental.compile(options, []);
    expect(second.stats.cacheHit).toBe(false);
    expect(second.diagnostics).toContainEqual(
      expect.objectContaining({ code: "source-typescript", severity: "error", errorCode: "TS2322" }),
    );
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

  test("semantic errors fail even when no escape syntax is present or strict scanning is disabled", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "supacloud-compiler-semantic-"));
    await writeFixtureProject(rootDir, {
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
      "src/production.ts": 'export const value: number = "wrong";',
    });
    expect(scanProductionSource({ rootDir, strict: false })).toContainEqual(
      expect.objectContaining({ severity: "error", code: "source-typescript", errorCode: "TS2322" }),
    );
  });

  test("suppression directives cannot hide production errors while quoted text remains valid", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "supacloud-compiler-suppression-"));
    await writeFixtureProject(rootDir, {
      "src/production.ts": '// @ts-nocheck\nexport const value: number = "wrong";',
      "src/literal.ts": 'export const label = "// @ts-ignore";',
      "src/suppressed.ts": '// @ts-expect-error\nexport const value: number = "wrong";',
    });
    expect(scanProductionSource({ rootDir })).toEqual([
      expect.objectContaining({ severity: "error", code: "source-type-suppression", errorCode: "SC6006", file: "src/production.ts" }),
      expect.objectContaining({ severity: "error", code: "source-type-suppression", errorCode: "SC6006", file: "src/suppressed.ts" }),
    ]);
  });

  test("a source-directory root uses the enclosing project's aliases and strict configuration", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "supacloud-source-root-"));
    await writeFixtureProject(rootDir, {
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true, moduleResolution: "bundler", module: "esnext",
          noUncheckedIndexedAccess: true, paths: { "@models/*": ["./src/models/*"] },
        },
      }),
      "src/models/value.ts": 'export const values: string[] = [];',
      "src/production.ts": 'import { values } from "@models/value";\nexport const value: string = values[0];',
    });
    const diagnostics = scanProductionSource({ rootDir: join(rootDir, "src") });
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "source-typescript", errorCode: "TS2322", file: "production.ts" }),
    ]);
  });
});
