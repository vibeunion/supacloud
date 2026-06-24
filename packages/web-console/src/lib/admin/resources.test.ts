import { describe, expect, test } from "bun:test";
import { buildResourceRegistry } from "./resources";

describe("buildResourceRegistry", () => {
  test("includes tenant auth resources for every known project", () => {
    const registry = buildResourceRegistry(["alpha123", "beta456"]);
    const names = registry.map((resource) => resource.name);

    expect(names).toContain("v1/projects/alpha123/auth/users");
    expect(names).toContain("v1/projects/beta456/auth/users");
    expect(names).toContain("v1/projects/alpha123/database/tables");
  });

  test("deduplicates repeated project refs", () => {
    const registry = buildResourceRegistry(["alpha123", "alpha123"]);
    const authResources = registry.filter(
      (resource) => resource.name === "v1/projects/alpha123/auth/users",
    );

    expect(authResources).toHaveLength(1);
  });
});
