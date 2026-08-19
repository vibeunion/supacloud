import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const dashboardRouteSource = readFileSync(
  new URL("../../src/routes/project-dashboard.ts", import.meta.url),
  "utf8"
);
const edgeFunctionSource = readFileSync(
  new URL("../../src/services/edge-function.service.ts", import.meta.url),
  "utf8"
);

describe("project dashboard and edge function diagnostics", () => {
  test("dashboard table and index counters filter for public schema tables", () => {
    expect(dashboardRouteSource).toContain("SELECT count(*)::int AS cnt FROM pg_stat_user_tables WHERE schemaname = 'public'");
    expect(dashboardRouteSource).toContain("SELECT count(*)::int AS cnt FROM pg_stat_user_indexes WHERE schemaname = 'public'");
  });

  test("edge function bundling reports detailed compiler diagnostics on failure", () => {
    expect(edgeFunctionSource).toContain("messages ? `Bun.build() failed while bundling the function: ${messages}` : \"Bun.build() failed while bundling the function\"");
  });
});
