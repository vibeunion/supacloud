import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const pageSource = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");

describe("project dashboard", () => {
  test("renders the project quick links in exactly one section", () => {
    expect(pageSource.match(/\{#each QUICK_LINKS/g) ?? []).toHaveLength(1);
    expect(pageSource).toContain("<!-- Quick Links -->");
    expect(pageSource).not.toContain("<!-- Quick Access Cards -->");
  });

  test("rejects stale dashboard responses after project changes or refreshes", () => {
    expect(pageSource).toContain("createProjectLoadToken");
    expect(pageSource).toContain("isCurrentProjectLoad(loadToken, projectRef, loadRevision)");
    expect(pageSource).toContain("loadRevision += 1;");
    expect(pageSource).toContain("if (isCurrentLoad(loadToken)) applyDashboardSummary(summary);");
    expect(pageSource).toContain("if (isCurrentLoad(loadToken)) servicesLoading = false;");
    expect(pageSource).toContain("if (nextTaskStats && isCurrentLoad(loadToken)) taskStats = nextTaskStats;");
    expect(pageSource).toContain("resetProjectDashboardState();");
    expect(pageSource).toContain("services = [];");
    expect(pageSource).toContain("authManagedByRef = null;");
    expect(pageSource).toContain("onclick={() => loadProject(projectRef)}");
  });
});
