import { describe, expect, test } from "bun:test";
import { createProjectLoadToken, isCurrentProjectLoad } from "./project-load-guard";

describe("project load guard", () => {
  test("rejects stale responses after a project ref change", () => {
    const dependentLoad = createProjectLoadToken("tenant-a", 1);
    const ownerLoad = createProjectLoadToken("auth-owner", 2);

    expect(isCurrentProjectLoad(dependentLoad, "auth-owner", 2)).toBeFalse();
    expect(isCurrentProjectLoad(ownerLoad, "auth-owner", 2)).toBeTrue();
  });

  test("rejects an older refresh for the same project", () => {
    const firstLoad = createProjectLoadToken("tenant-a", 1);
    const refreshedLoad = createProjectLoadToken("tenant-a", 2);

    expect(isCurrentProjectLoad(firstLoad, "tenant-a", 2)).toBeFalse();
    expect(isCurrentProjectLoad(refreshedLoad, "tenant-a", 2)).toBeTrue();
  });
});
