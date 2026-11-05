import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as ts from "./typescript";
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
    await using session = createIncrementalProgramSession(rootDir);
    const files = [
      join(rootDir, "src/features/audit/audit.module.ts"),
      join(rootDir, "src/features/case/case.service.ts"),
      join(rootDir, "src/features/health/health.module.ts"),
    ];

    const first = (await session.update(files));
    const auditBefore = first.program.getSourceFile(files[0]);
    const caseBefore = first.program.getSourceFile(files[1]);
    expect(session.getTraits().some((trait) => trait.kind === "module" && trait.name === "AuditModule")).toBe(true);
    expect(session.getTraits().some((trait) => trait.kind === "defineModule" && trait.name === "HealthModule")).toBe(true);
    expect(session.getTraits().some((trait) => trait.kind === "injectionToken")).toBe(true);

    await appendFile(join(rootDir, "src/features/audit/audit.module.ts"), "\n// changed\n", "utf8");
    const second = (await session.update(files, ["src/features/audit/audit.module.ts"]));
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
    await using session = createIncrementalProgramSession(root);
    const dependency = join(root, "src/dependency.ts");
    const files = [join(root, "src/main.ts"), dependency];
    (await session.update(files));
    await writeFile(dependency, "export const value = 2;\n");
    const updated = (await session.update(files, []));
    expect(updated.program.getSourceFile(dependency)?.text).toContain("value = 2");
    expect(updated.changedFiles).toContain(dependency);
  });

  test("reloads inherited compiler options without requiring a new session", async () => {
    const root = await fixture({
      "tsconfig.json": '{"extends":"./base.json","include":["src"]}',
      "base.json": '{"compilerOptions":{"target":"ES2022","module":"ESNext"}}',
      "src/main.ts": "export const value = 1;\n",
    });
    await using session = createIncrementalProgramSession(root);
    const file = join(root, "src/main.ts");
    const first = (await session.update([file]));
    expect(first.program.getCompilerOptions().target).toBe(ts.ScriptTarget.ES2022);
    await writeFile(join(root, "base.json"), '{"compilerOptions":{"target":"ES2020","module":"ESNext"}}');
    const next = (await session.update([file], ["base.json"]));
    expect(next.program.getCompilerOptions().target).toBe(ts.ScriptTarget.ES2020);
  });

  test("invalidates missing-file caches on import creation, deletion and recreation", async () => {
    const root = await fixture({
      "src/main.ts": 'export { value } from "./dependency";\n',
    });
    await using session = createIncrementalProgramSession(root);
    const files = [join(root, "src/main.ts")];
    const dependency = join(root, "src/dependency.ts");
    (await session.update(files));
    await writeFile(dependency, "export const value = 1;\n");
    expect((await session.update(files, [dependency])).program.getSourceFile(dependency)?.text).toContain("value = 1");
    await rm(dependency);
    const removed = (await session.update(files, [dependency]));
    expect(removed.program.getSourceFile(dependency)).toBeUndefined();
    expect(removed.changedFiles).toContain(dependency);
    await writeFile(dependency, "export const value = 2;\n");
    expect((await session.update(files, [dependency])).program.getSourceFile(dependency)?.text).toContain("value = 2");
  });

  test("retains the builder emit state for unaffected files", async () => {
    const root = await fixture({
      "tsconfig.json": '{"compilerOptions":{"target":"ES2022","module":"ESNext","outDir":"dist","rootDir":"src"},"include":["src"]}',
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 1;\n",
    });
    await using session = createIncrementalProgramSession(root);
    const files = [join(root, "src/a.ts"), join(root, "src/b.ts")];
    (await session.update(files));
    expect((await session.emit()).emitSkipped).toBe(false);
    const output = join(root, "dist/b.js");
    await writeFile(output, "// unchanged output\n");
    await writeFile(files[0], "export const a = 2;\n");
    (await session.update(files, [files[0]]));
    expect((await session.emit()).emitSkipped).toBe(false);
    expect(await readFile(join(root, "dist/a.js"), "utf8")).toContain("a = 2");
    expect(await readFile(output, "utf8")).toBe("// unchanged output\n");
    (await session.reset());
    (await session.update(files));
    (await session.emit());
    expect(await readFile(output, "utf8")).toContain("b = 1");
  });
});

describe("TypeScript 7 asynchronous API on Bun", () => {
  test("resolves virtual declarations and reports semantic errors", async () => {
    const root = await fixture({});
    const file = join(root, "virtual.ts");
    await using program = await ts.createProgram([file], { strict: true, noLib: true }, {
      cwd: root, sources: new Map([[file, 'export const value: string = 123;\n']]),
    });
    const source = program.getSourceFile(file)!;
    const checker = program.getTypeChecker();
    const symbol = await checker.getSymbolAtLocation(source);
    const exports = await checker.getExportsOfModule(symbol!);
    expect((await ts.declarationsOf(exports[0]))[0]?.getSourceFile()).toBe(source);
    expect((await program.getSemanticDiagnostics()).some(error => error.code === 2322)).toBe(true);
  });

  test("binds aliases and prints an HTTP provider migration", async () => {
    const { migrateHttpProviderImports } = await import("./http-provider-migration");
    const source = 'import { provideHttpClient, withInterceptors } from "@supacloud/app";\nprovideHttpClient(withInterceptors([]));\n';
    const result = await migrateHttpProviderImports(source, "provider.ts");
    expect(result.issues).toEqual([]);
    expect(result.changed).toBe(true);
    expect(result.content).toContain('from "@supacloud/app/http"');
    expect(result.content).toContain('provideHttpClient(withInterceptors([]))');
  });

  test("projects GraphQL result validators through asynchronous types", async () => {
    const { renderGraphqlValidators } = await import("./graphql-runtime");
    const output = await renderGraphqlValidators('export type ViewerQuery = { viewer: { id: string } | null };', ["Viewer"]);
    expect(output).toContain("ViewerQuery");
    expect(output).toContain('"id"');
  });

  test("runs project analysis and source semantic gates without TS 6", async () => {
    const { analyzeProject } = await import("./analyze");
    const { scanProductionSource } = await import("./type-safety");
    const root = await fixture(GOOD_PROJECT_FILES);
    const graph = await analyzeProject(root);
    expect(graph.modules.some(module => module.name === "audit")).toBe(true);
    await writeFile(join(root, "src/unsafe.ts"), 'const value: string = 1;\nPromise.resolve(1);\n');
    const diagnostics = await scanProductionSource({ rootDir: root, strict: true });
    expect(diagnostics.some(error => error.errorCode === "TS2322")).toBe(true);
    expect(diagnostics.some(error => error.code === "source-floating-promise")).toBe(true);
  });
  test("keeps GraphQL inputs and excludes generated directories", async () => {
    const root = await fixture({
      "schema.graphql": "type Query { viewer: String }",
      "queries/viewer.gql": "query Viewer { viewer }",
      "dist/ignored.gql": "query Ignored { viewer }",
    });
    const files = await ts.sys.readDirectory(root, [".graphql", ".gql"], ["dist"], ["**/*.graphql", "**/*.gql"]);
    expect(files.map(file => file.slice(root.length + 1))).toEqual(["queries/viewer.gql", "schema.graphql"]);
    const source = await ts.createSourceFile("detached.ts", "export const value = 1;");
    expect(await ts.printNode(source.statements[0]!)).toContain("value = 1");
  });

  test("preserves import fingerprints and rewrites literal dynamic import wrappers", async () => {
    const { staticDeliveryImports } = await import("./delivery-imports");
    const first = await ts.createSourceFile("imports.ts", "import { value } from './value'; import('./dynamic');");
    const second = await ts.createSourceFile("imports.ts", "// comment\n\nimport {value} from './value'; import('./dynamic');");
    expect(await ts.printNode(second.statements[0]!)).toBe(await ts.printNode(first.statements[0]!));
    const source = 'export {}; function load(path: string) { return import(path); } export const result = load("./value");';
    const output = new TextDecoder().decode(await staticDeliveryImports(join(process.cwd(), "wrapper.ts"), new TextEncoder().encode(source)));
    expect(output).toContain('import("./value")');
    expect(output).not.toContain("function load");
  });

  test("checks command boundaries introduced on main with native asynchronous symbols", async () => {
    const { scanCommandBoundaries } = await import("./command-boundary");
    const root = await fixture({});
    const file = join(root, "command.ts");
    await using program = await ts.createProgram([file], { strict: true, noLib: true }, {
      cwd: root, sources: new Map([[file, `class WriteCommand { execute() { return 1; } }
const command = new WriteCommand();
command.execute();
const { execute } = command;`]]),
    });
    const source = program.getSourceFile(file)!;
    const declaration = source.statements.find(ts.isClassDeclaration)!;
    const diagnostics = await scanCommandBoundaries(source, "command.ts", program.getTypeChecker(),
      [{ declaration, name: "write" }], new Map());
    expect(diagnostics.map(item => item.code)).toEqual(["command-executor-bypass", "command-executor-bypass"]);
  });

});
