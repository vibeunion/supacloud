import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("project config route registration", () => {
  test("registers GET /:ref/network-restrictions exactly once", () => {
    const projectConfigSource = readFileSync(
      new URL("../../src/routes/project-config.ts", import.meta.url),
      "utf8",
    );
    const networkRouteSource = readFileSync(
      new URL("../../src/routes/project-network-restrictions.ts", import.meta.url),
      "utf8",
    );
    const getRegistrations = networkRouteSource.match(/\.get\(\s*"\/:ref\/network-restrictions"/g) || [];
    expect(getRegistrations).toHaveLength(1);
    expect(projectConfigSource.match(/\.use\(projectNetworkRestrictionRoutes\)/g) || []).toHaveLength(1);
  });
});
