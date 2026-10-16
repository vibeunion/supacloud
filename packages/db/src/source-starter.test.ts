import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as ts from "@typescript/typescript6";
import { initializeAppProject, appStarterFiles } from "../../cli/src/shared/tools/app-starter";
import { appTemplateFiles } from "../../cli/src/shared/tools/app-starter-templates";
import { databaseSources } from "./source-contracts";
import { lintModule } from "./lint";
import type { DatabaseModule } from "./module";
import { pathToFileURL } from "node:url";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
test("database starter ships a source contract and live module ownership without rewriting migration history", async () => {
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
  expect(await readFile(join(root, "db/modules.ts"), "utf8")).toContain('name: "starter"');
});
test("default checks run before regeneration and Drizzle candidate paths never replace the deployment ledger", () => {
  const files = appStarterFiles("example");
  expect(files["package.json"]).toContain('"check": "bun run db:check &&');
  expect(files["package.json"]).toContain('"build": "bun run db:check &&');
  expect(files["package.json"]).toContain('"drizzle-orm": "1.0.0-rc.5-5935859"');
  expect(files["package.json"]).toContain('"drizzle-kit": "1.0.0-rc.5-5935859"');
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
test("generated database module loads real Drizzle names and its SQL passes governance", async () => {
  const root = await mkdtemp(join(tmpdir(), "db-starter-module-"));
  roots.push(root);
  await initializeAppProject({ root, name: "example", template: "command" });
  await symlink(resolve(import.meta.dir, "../../compiler/node_modules"), join(root, "node_modules"), "dir");
  const loaded = await import(pathToFileURL(join(root, "db/modules.ts")).href) as { default: DatabaseModule };
  expect(loaded.default.tables).toEqual([
    "public.starter_application", "public.starter_reviews", "public.starter_members",
    "public.starter_attachments", "public.starter_attachment_results", "public.starter_attachment_retries",
  ]);
  expect(loaded.default.policies).toHaveLength(20);
  expect(await lintModule(loaded.default, path => readFile(join(root, path), "utf8"))).toEqual([]);
  for (const policy of loaded.default.policies) {
    expect(await readFile(join(root, policy.source), "utf8")).toContain(`CREATE POLICY ${policy.name} ON ${policy.table}`);
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
      typeRoots: [join(root, "node_modules/@types")],
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

test("temporary delivery upgrades regenerate contracts and restore the exact baseline on success or failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "db-starter-upgrade-"));
  roots.push(root);
  await initializeAppProject({ root, name: "example", template: "command" });
  await symlink(resolve(import.meta.dir, "../../compiler/node_modules"), join(root, "node_modules"), "dir");
  expect((await databaseSources(root, "generate")).ok).toBe(true);
  const contracts = (await readdir(join(root, "db/contracts"))).sort();
  const baseline = await Promise.all(contracts.map(name => readFile(join(root, "db/contracts", name), "utf8")));
  const migrations = (await readdir(join(root, "migrations"))).sort();
  const adapter = await readFile(join(root, "src/host/review-attachments.ts"), "utf8");
  await writeFile(join(root, "tests/delivery-compatibility.ts"), await readFile(
    resolve(import.meta.dir, "../../../scripts/fixtures/starter-delivery-compatibility.fixture"), "utf8"));
  // Replace only the expensive archive builder, not the real fixture or source
  // contract gate. Both ordinary database CI and the command gate run this test.
  await writeFile(join(root, "tests/delivery-archive.ts"), `
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { databaseSources } from "@supacloud/db/source-contracts";
export const observations: unknown[] = [];
export let rejectBuild = false;
export function failNextBuild() { rejectBuild = true; }
export async function buildReferenceDeliveryArchive() {
  const project = fileURLToPath(new URL("..", import.meta.url));
  const report = await databaseSources(project, "check");
  if (!report.ok) throw new Error(JSON.stringify(report.findings));
  observations.push(JSON.parse(await readFile(new URL("../db/contracts/manifest.json", import.meta.url), "utf8")));
  if (rejectBuild) throw new Error("Synthetic archive build failure");
  return { verified: true };
}
export function prepareArchivedDelivery() { throw new Error("Not used by source-contract regression"); }
`);
  const fixture = await import(pathToFileURL(join(root, "tests/delivery-compatibility.ts")).href) as {
    buildReferenceUpgradeArchive(directory: string, signal: AbortSignal): Promise<unknown>;
  };
  const builder = await import(pathToFileURL(join(root, "tests/delivery-archive.ts")).href) as {
    observations: Array<{ migrations: Array<{ path: string }> }>;
    failNextBuild(): void;
  };
  for (const reject of [false, true]) {
    if (reject) builder.failNextBuild();
    const build = fixture.buildReferenceUpgradeArchive(join(root, "output/upgrade"), new AbortController().signal);
    if (reject) await expect(build).rejects.toThrow("Synthetic archive build failure");
    else expect(await build).toEqual({ verified: true });
    expect(builder.observations.at(-1)?.migrations.map(item => item.path)).toEqual([
      ...migrations.map(name => "migrations/" + name), "migrations/006-reference-compatibility.sql",
    ]);
    expect((await readdir(join(root, "migrations"))).sort()).toEqual(migrations);
    expect(await readFile(join(root, "src/host/review-attachments.ts"), "utf8")).toBe(adapter);
    expect((await readdir(join(root, "db/contracts"))).sort()).toEqual(contracts);
    expect(await Promise.all(contracts.map(name => readFile(join(root, "db/contracts", name), "utf8")))).toEqual(baseline);
    expect((await databaseSources(root, "check")).ok).toBe(true);
  }
  expect(builder.observations).toHaveLength(2);
}, 30_000);
