import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const pageSource = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");
const projectsPageSource = readFileSync(new URL("./projects/+page.svelte", import.meta.url), "utf8");
const createProjectPageSource = readFileSync(new URL("./projects/create/+page.svelte", import.meta.url), "utf8");
const projectSwitcherSource = readFileSync(new URL("../lib/components/ProjectSwitcher.svelte", import.meta.url), "utf8");
const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { dependencies: Record<string, string> };
const lockSource = readFileSync(new URL("../../bun.lock", import.meta.url), "utf8");
const viteSource = readFileSync(new URL("../../vite.config.ts", import.meta.url), "utf8");

describe("SupaCloud root dashboard", () => {
  test("keeps the root page connected to real SupaCloud data", () => {
    expect(pageSource).toContain('apiClient("/v1/projects")');
    expect(pageSource).toContain('apiClient("/v1/system/info")');
    expect(pageSource).toContain("SupaCloud Console");
    expect(pageSource).toContain("平台概览");
    expect(pageSource).toContain("不使用演示数据");
  });

  test("keeps project navigation base-path safe", () => {
    expect(pageSource).toContain('import { resolve } from "$app/paths";');
    expect(pageSource).toContain('goto(resolve("/projects"))');
    expect(pageSource).toContain("{#each filteredProjects.slice(0, 6) as project (project.ref)}");
    expect(pageSource).toContain('href={resolve("/project/[ref]", { ref: project.ref })}');
  });

  test("keeps every new-project entrypoint connected to the creation form", () => {
    expect(projectsPageSource).toContain('href="/projects/create"');
    expect(projectSwitcherSource).toContain('goto("/projects/create")');
    expect(createProjectPageSource).toContain('apiClient("/v1/projects"');
    expect(createProjectPageSource).toContain("method: \"POST\"");
    expect(createProjectPageSource).toContain("window.location.assign");
    expect(createProjectPageSource).toContain("encodeURIComponent(ref)");
  });

  test("contains no unrelated demo business content", () => {
    expect(pageSource).not.toContain("Paw Haven");
    expect(pageSource).not.toContain("Shelter Management");
    expect(pageSource).not.toContain("Recent Animals");
    expect(pageSource).not.toContain("images.unsplash.com");
  });

  test("locks the released svadmin adapters and Vite compatibility rule", () => {
    expect(packageJson.dependencies["@svadmin/core"]).toBe("^0.32.2");
    expect(packageJson.dependencies["@svadmin/ui"]).toBe("^0.38.7");
    expect(packageJson.dependencies["@svadmin/sveltekit"]).toBe("^0.9.6");
    expect(packageJson.dependencies["@svadmin/elysia"]).toBe("^0.10.7");
    expect(lockSource).toContain('"@svadmin/core@0.32.2"');
    expect(lockSource).toContain('"@svadmin/ui@0.38.7"');
    expect(lockSource).toContain('"@svadmin/sveltekit@0.9.6"');
    expect(viteSource).toContain("'@svadmin/core'");
  });
});
