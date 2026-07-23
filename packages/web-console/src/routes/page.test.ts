import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const pageSource = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");

describe("root dashboard", () => {
  test("uses live platform data instead of a static marketing collection", () => {
    expect(pageSource).toContain('apiClient("/v1/projects")');
    expect(pageSource).toContain('apiClient("/v1/system/info")');
    expect(pageSource).toContain('$t("GlobalDashboard.welcome")');
    expect(pageSource).not.toContain("Infrastructure Collective");
    expect(pageSource).not.toContain("Cathedral Lodge");
  });

  test("keeps dashboard links valid when Studio is mounted under a base path", () => {
    expect(pageSource).toContain('import { resolve } from "$app/paths";');
    expect(pageSource).toContain('goto(resolve("/projects"))');
    expect(pageSource).toContain("{#each projects as project (project.ref)}");
    expect(pageSource).toContain('href={resolve("/project/[ref]", { ref: project.ref })}');
  });
});
