import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadControlPlaneQueries } from "../../src/db/reylo";
import { PROJECT_TASK_ATTEMPT_COLUMNS, PROJECT_TASK_COLUMNS } from "../../src/db/contracts/task-row";

const queryRoot = join(import.meta.dir, "../../src/db/reylo/queries");

function columns(sql: string, table: string): string[] {
  const body = sql.replace(/^with[\s\S]*?\)\s*(select)/i, "$1");
  const match = body.match(new RegExp(`select\\s+([\\s\\S]*?)\\s+from\\s+${table}\\b`, "i"));
  if (!match) throw new Error(`Missing select list for ${table}`);
  return match[1].split(",")
    .map((column) => column.trim().replace(/^[a-z_]+\\./i, ""))
    .filter((column) => /^[a-z_]+$/i.test(column));
}

describe("Reylo control-plane queries", () => {
  test("stay disabled unless the production build enables them", async () => {
    if (process.env.SUPACLOUD_REYLO_QUERIES === "1") return;
    expect(await loadControlPlaneQueries()).toBeNull();
  });

  test("all SQL uses explicit columns and named parameters", async () => {
    const files = (await readdir(queryRoot)).filter((name) => name.endsWith(".sql")).sort();
    expect(files.length).toBeGreaterThanOrEqual(12);
    for (const file of files) {
      const source = await readFile(join(queryRoot, file), "utf8");
      expect(source).not.toMatch(/select\s+\*/i);
      expect(source).not.toMatch(/returning\s+\*/i);
      expect(source).toMatch(/:[a-z_]+::[a-z0-9_]+/i);
    }
  });

  test("full task queries match the canonical row contracts", async () => {
    const scopedSql = await readFile(join(queryRoot, "task_get_full.sql"), "utf8");
    const unscopedSql = await readFile(join(queryRoot, "task_get_full_unscoped.sql"), "utf8");
    const attemptSql = await readFile(join(queryRoot, "task_attempts_full.sql"), "utf8");
    const taskColumns = PROJECT_TASK_COLUMNS.split(", ");
    expect(columns(unscopedSql, "project_tasks")).toEqual(taskColumns);
    for (const column of taskColumns) expect(scopedSql).toContain(`t.${column}`);
    expect(columns(attemptSql, "project_task_attempts")).toEqual(PROJECT_TASK_ATTEMPT_COLUMNS.split(", "));
  });
});
