import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { checkBoundaries, type ProjectConfig } from "./check_workspace_boundaries";

function project(name: string, tags: string[], dependencies: string[] = []): ProjectConfig {
  return { name, tags, dependencies, path: `/workspace/${name}` };
}

describe("Workspace Boundaries Check", () => {
  test("passes boundary validation for current SupaCloud workspace", () => {
    const scriptPath = join(import.meta.dir, "check_workspace_boundaries.ts");
    const result = spawnSync("bun", ["run", scriptPath], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("All workspace architectural boundaries and module tags are respected!");
  });

  test("enforces API, runtime, app, database, and distribution directions", () => {
    const projects = new Map<string, ProjectConfig>([
      ["@supacloud/management-api", project("@supacloud/management-api", ["scope:cloud", "type:api"], ["web-console"])],
      ["@supacloud/edge-runtime", project("@supacloud/edge-runtime", ["scope:runtime", "type:runtime"], ["@supacloud/compiler"])],
      ["web-console", project("web-console", ["scope:cloud", "type:app"], ["@supacloud/db"])],
      ["@supacloud/db", project("@supacloud/db", ["scope:core", "type:database"])],
      ["@supacloud/compiler", project("@supacloud/compiler", ["scope:tooling", "type:compiler"])],
      ["supacloud", project("supacloud", ["scope:meta", "type:distribution"], ["@supacloud/management-api"])],
    ]);

    const result = checkBoundaries(projects);
    const violations = result.errors.filter((error) => error.startsWith("[Boundary Violation]"));
    expect(violations).toHaveLength(4);
    expect(violations.join("\n")).toContain("@supacloud/management-api");
    expect(violations.join("\n")).toContain("@supacloud/edge-runtime");
    expect(violations.join("\n")).toContain("web-console");
    expect(violations.join("\n")).toContain("supacloud");
  });
});
