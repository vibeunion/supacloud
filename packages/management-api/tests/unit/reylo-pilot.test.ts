import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadReyloPilot } from "../../src/db/reylo-pilot/index.ts";

const queryRoot = join(import.meta.dir, "../../src/db/reylo-pilot/queries");

describe("Reylo pilot", () => {
  test("stays disabled unless explicitly enabled", async () => {
    if (process.env.SUPACLOUD_REYLO_PILOT === "1") return;
    expect(await loadReyloPilot()).toBeNull();
  });

  test("all pilot SQL uses explicit columns and named parameters", async () => {
    const files = (await readdir(queryRoot)).filter((name) => name.endsWith(".sql")).sort();
    expect(files).toEqual([
      "organization_get.sql",
      "project_get.sql",
      "task_attempts_list.sql",
      "task_get.sql",
      "task_list_due.sql",
      "task_list_for_project.sql",
      "task_status_counts.sql",
    ]);
    for (const file of files) {
      const source = await readFile(join(queryRoot, file), "utf8");
      expect(source).not.toMatch(/select\s+\*/i);
      expect(source).not.toMatch(/returning\s+\*/i);
      expect(source).toMatch(/:[a-z_]+::[a-z0-9_]+/i);
    }
  });
});
