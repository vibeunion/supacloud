import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMigrationImportPlan, writeMigrationImportPlan } from "./migration-import";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

test("imports Nhost SQL without replacing Supabase migration or pg_graphql contracts", () => {
  const plan = createMigrationImportPlan({ source: "nhost", metadata: undefined });
  expect(plan.compatibility).toEqual({ supabase_migrations: true, pg_graphql: "preserved", rls: "manual_review" });
  expect(plan.warnings[0]).toContain("Nhost Auth");
});

test("turns Hasura table metadata into a reviewable RLS migration", () => {
  const plan = createMigrationImportPlan({
    source: "hasura",
    metadata: { sources: [{ tables: [{ table: { schema: "public", name: "todos" } }] }] },
  });
  expect(plan.files[0]).toMatchObject({ source: "hasura-metadata", name: "hasura_rls_review" });
  expect(plan.files[0]?.sql).toContain('ALTER TABLE "public"."todos" ENABLE ROW LEVEL SECURITY;');
  expect(plan.warnings.join("\n")).toContain("USING/WITH CHECK");
});

test("exports Hasura application primitives into a non-executable review artifact", () => {
  const plan = createMigrationImportPlan({
    source: "hasura",
    metadata: {
      actions: [{ name: "send_email" }],
      remote_schemas: [{ name: "billing", definition: { url: "https://billing.invalid/graphql" } }],
      sources: [{ tables: [{ event_triggers: [{ name: "orders_changed" }] }] }],
    },
  });
  const review = plan.files.find(file => file.source === "hasura-application-review");
  expect(review?.sql).toContain("SUPACLOUD IMPORT REVIEW ONLY");
  expect(review?.sql).toContain("send_email");
  expect(review?.sql).toContain("orders_changed");
  expect(review?.sql).not.toContain("CREATE FUNCTION");
  expect(plan.warnings.join("\n")).toContain("explicit SupaCloud Function/Event mapping");
});

test("writes an import plan only when explicitly requested and never applies SQL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "migration-import-"));
  temporary.push(directory);
  const plan = createMigrationImportPlan({
    source: "hasura",
    metadata: { sources: [{ tables: [{ table: { schema: "public", name: "todos" } }] }] },
  });
  const output = join(directory, "supabase", "migrations");
  const written = await writeMigrationImportPlan(plan, output);
  expect(written).toHaveLength(1);
  expect(await readFile(written[0]!, "utf8")).toContain("ENABLE ROW LEVEL SECURITY");
  await expect(writeMigrationImportPlan(plan, output)).rejects.toThrow();
});
