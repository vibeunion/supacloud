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
    expect(pageSource).toContain('$t("Dashboard.console_name")');
    expect(pageSource).toContain('$t("Dashboard.platform_overview")');
    expect(pageSource).toContain('$t("Dashboard.management_api_reading")');
  });

  test("normalizes project status without exposing implementation enum values", () => {
    expect(pageSource).toContain('["active", "active_healthy", "healthy", "running"]');
    expect(pageSource).toContain('return $t("Dashboard.status_active")');
    expect(pageSource).toContain('title={project.status}');
    expect(pageSource).not.toContain('>{project.status}<');
  });

  test("keeps platform destinations in navigation instead of dashboard quick links", () => {
    expect(pageSource).toContain('href: "/platform/operations"');
    expect(pageSource).toContain('href: "/platform/backups"');
    expect(pageSource).toContain('href: "/platform/settings"');
    expect(pageSource).not.toContain('class="quick-links"');
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
    expect(projectSwitcherSource).toContain("TenantSwitcher");
    expect(projectSwitcherSource).toContain("onSwitch={switchProject}");
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
    expect(packageJson.dependencies["@svadmin/core"]).toBe("^0.47.0");
    expect(packageJson.dependencies["@svadmin/ui"]).toBe("0.65.0");
    expect(packageJson.dependencies["@svadmin/sveltekit"]).toBe("^0.10.2");
    expect(packageJson.dependencies["@svadmin/elysia"]).toBe("^0.11.0");
    expect(lockSource).toContain('"@svadmin/core@0.47.0"');
    expect(lockSource).toContain('"@svadmin/ui@0.65.0"');
    expect(lockSource).toContain('"@svadmin/sveltekit@0.10.2"');
    expect(lockSource).toContain('"@svadmin/elysia@0.11.0"');
    expect(viteSource).toContain("'@svadmin/core'");
  });
});
