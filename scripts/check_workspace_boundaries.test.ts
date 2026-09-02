import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

describe("Workspace Boundaries Check", () => {
  test("passes boundary validation for current SupaCloud workspace", () => {
    const scriptPath = join(import.meta.dir, "check_workspace_boundaries.ts");
    const result = spawnSync("bun", ["run", scriptPath], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("All workspace architectural boundaries and module tags are respected!");
  });
});
