import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planMigrationRebase, rebaseMigrations } from "./migration-rebase";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("plans a compact baseline while preserving forward migrations and source hashes", () => {
  const plan = planMigrationRebase([
    { file: "20260101000000_one.sql", version: "20260101000000", name: "one", sql: "CREATE TABLE one(id int);" },
    { file: "20260201000000_two.sql", version: "20260201000000", name: "two", sql: "ALTER TABLE one ADD COLUMN name text;" },
  ], {
    sourceDirectory: "supabase/migrations",
    outputDirectory: "supabase/migrations-rebased",
    baselineFile: "backups/schema.sql",
    baselineVersion: "20261008000000",
    retainAfterVersion: "20260101000000",
  }, "CREATE TABLE one(id int, name text);");

  expect(plan.baselineMigration).toBe("20261008000000_reconstructed_schema.sql");
  expect(plan.archivedMigrations).toEqual(["20260101000000_one.sql"]);
  expect(plan.retainedMigrations).toEqual(["20260201000000_two.sql"]);
  expect(plan.sourceHistorySha256).toMatch(/^[a-f0-9]{64}$/);
  expect(plan.warnings.length).toBe(3);
});

test("writes only a separate rebased directory and manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "migration-rebase-"));
  roots.push(root);
  const source = join(root, "migrations");
  const output = join(root, "rebased");
  const snapshot = join(root, "schema.sql");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "20260101000000_one.sql"), "CREATE TABLE one(id int);\n");
  await writeFile(join(source, "20260201000000_two.sql"), "ALTER TABLE one ADD COLUMN name text;\n");
  await writeFile(snapshot, "CREATE TABLE one(id int, name text);\n");

  const plan = await rebaseMigrations({
    sourceDirectory: source,
    outputDirectory: output,
    baselineFile: snapshot,
    baselineVersion: "20261008000000",
    retainAfterVersion: "20260101000000",
  });

  expect((await readdir(source)).sort()).toEqual([
    "20260101000000_one.sql",
    "20260201000000_two.sql",
  ]);
  expect((await readdir(output)).sort()).toEqual([
    "20260201000000_two.sql",
    "20261008000000_reconstructed_schema.sql",
    "migration-rebase.manifest.json",
  ]);
  expect(await readFile(join(output, plan.baselineMigration), "utf8")).toContain("CREATE TABLE");
  expect(JSON.parse(await readFile(join(output, "migration-rebase.manifest.json"), "utf8")).sourceHistory).toHaveLength(2);
});
