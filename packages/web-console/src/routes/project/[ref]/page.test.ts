import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const pageSource = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");

describe("project dashboard", () => {
  test("loads the validated overview and service-control contracts", () => {
    expect(pageSource).toContain("loadProjectOverview(ref, apiClient, next.signal)");
    expect(pageSource).toContain("loadServiceControlState(ref, apiClient, next.signal)");
    expect(pageSource).toContain('data-metric="database"');
    expect(pageSource).toContain('data-metric="tasks"');
    expect(pageSource).toContain('aria-label="Refresh"');
  });

  test("clears and fences stale dashboard responses across project changes", () => {
    expect(pageSource).toContain("controller?.abort();");
    expect(pageSource).toContain("const next = new AbortController();");
    expect(pageSource).toContain("overview = null;");
    expect(pageSource).toContain("services = null;");
    expect(pageSource).toContain("if (next.signal.aborted) return;");
    expect(pageSource).toContain("return () => next.abort();");
    expect(pageSource).toContain("revision += 1;");
  });
});