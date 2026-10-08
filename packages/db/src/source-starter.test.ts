import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as ts from "@typescript/typescript6";
import { initializeAppProject, appStarterFiles } from "../../cli/src/shared/tools/app-starter";
import { appTemplateFiles } from "../../cli/src/shared/tools/app-starter-templates";
import { databaseSources } from "./source-contracts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
test("database starter ships a working offline default without connecting or rewriting migration history", async () => {
  const root = await mkdtemp(join(tmpdir(), "db-starter-"));
  roots.push(root);
  await initializeAppProject({ root, name: "example", template: "command" });
  const migration = await readFile(join(root, "migrations/001-review.sql"), "utf8");
  expect((await databaseSources(root)).ok).toBe(false);
  const generated = await databaseSources(root, "generate");
  expect(generated.findings).toEqual([]);
  expect(generated.ok).toBe(true);
  expect((await databaseSources(root)).ok).toBe(true);
  expect(await readFile(join(root, "migrations/001-review.sql"), "utf8")).toBe(migration);
  expect(await readFile(join(root, "db/contracts/rpc-types.ts"), "utf8")).not.toContain("any");
});
test("default checks run before regeneration and Drizzle candidate paths never replace the deployment ledger", () => {
  const files = appStarterFiles("example");
  expect(files["package.json"]).toContain('"check": "bun run db:check &&');
  expect(files["package.json"]).toContain('"build": "bun run db:check &&');
  expect(files["package.json"]).toContain('"drizzle-orm": "1.0.0-rc.5-169397b"');
  expect(files["package.json"]).toContain('"drizzle-kit": "1.0.0-rc.5-ab785fc"');
  expect(files["drizzle.config.ts"]).toContain("./db/migration-candidates");
  expect(files["drizzle.pull.config.ts"]).toContain("./output/database-audit/drizzle-candidate");
  expect(files[".gitignore"]).toContain("output/database-audit/");
  expect(files["AGENTS.md"]).toContain("Drizzle owns table declarations");
  expect(files["AGENTS.md"]).toContain("Do not introduce any/@ts-ignore");
  for (const template of ["http", "edge"] as const) {
    const plain = appTemplateFiles("example", template);
    expect(plain["package.json"]).not.toContain("drizzle");
    expect(plain["database.sources.json"]).toBeUndefined();
  }
});
test("generated Drizzle declarations and configuration typecheck; inferred row types reject invalid states", async () => {
  const root = await mkdtemp(join(tmpdir(), "db-starter-types-"));
  roots.push(root);
  await initializeAppProject({ root, name: "example", template: "command" });
  await symlink(resolve(import.meta.dir, "../node_modules"), join(root, "node_modules"), "dir");
  const path = join(root, "fixture.ts");
  const source = `import type { ReviewRow, NewReview } from "./db/schema";
const row: ReviewRow = { id: "id", ownerId: "owner", state: "draft", version: 1 };
const insert: NewReview = row;`;
  const diagnostics = async (text: string) => {
    await writeFile(path, text);
    return ts.getPreEmitDiagnostics(ts.createProgram([
      path, join(root, "drizzle.config.ts"), join(root, "drizzle.pull.config.ts"),
    ], {
      strict: true, noEmit: true, skipLibCheck: true, types: ["bun"],
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    }));
  };
  expect((await diagnostics(source)).map(item => ts.flattenDiagnosticMessageText(item.messageText, "\n"))).toEqual([]);
  expect((await diagnostics(source + '\nconst invalid: NewReview = { ...row, state: true };')).map(item => item.code)).toContain(2322);
});

test("Drizzle generates real SQL drafts without changing deployment migrations", async () => {
  const root = await mkdtemp(join(tmpdir(), "db-starter-diff-"));
  roots.push(root);
  await initializeAppProject({ root, name: "example", template: "command" });
  await symlink(resolve(import.meta.dir, "../node_modules"), join(root, "node_modules"), "dir");
  const migrationNames = await readdir(join(root, "migrations"));
  const before = await Promise.all(migrationNames.map(name => readFile(join(root, "migrations", name), "utf8")));
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../node_modules/drizzle-kit/bin.cjs"),
    "generate", "--config", "drizzle.config.ts"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(code, stdout + stderr).toBe(0);
  const drafts = await readdir(join(root, "db/migration-candidates"), { recursive: true });
  const sqlFile = drafts.find(name => name.endsWith(".sql"));
  expect(sqlFile).toBeDefined();
  expect(await readFile(join(root, "db/migration-candidates", sqlFile!), "utf8")).toContain("starter_reviews");
  expect(await readdir(join(root, "migrations"))).toEqual(migrationNames);
  expect(await Promise.all(migrationNames.map(name => readFile(join(root, "migrations", name), "utf8")))).toEqual(before);
}, 30_000);
