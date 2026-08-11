import { describe, expect, test } from "bun:test";
import { resolveAdminTenant } from "./tenant";

describe("resolveAdminTenant", () => {
  const projectRefs = ["alpha", "beta"];

  test("returns a tenant only for an exact known project route", () => {
    expect(resolveAdminTenant({ projectRefs, projectRef: "alpha" })).toEqual({
      tenantId: "alpha",
      meta: { projectRef: "alpha" },
    });
    expect(resolveAdminTenant({ projectRefs, projectRef: "beta" })).toEqual({
      tenantId: "beta",
      meta: { projectRef: "beta" },
    });
  });

  test("does not fall back to the first project for an unknown ref", () => {
    expect(resolveAdminTenant({ projectRefs, projectRef: "missing" })).toBeUndefined();
  });

  test("does not expose a tenant on platform or unauthenticated routes", () => {
    expect(resolveAdminTenant({ projectRefs, projectRef: "alpha", isPlatformRoute: true })).toBeUndefined();
    expect(resolveAdminTenant({ projectRefs, projectRef: "alpha", isRawPage: true })).toBeUndefined();
    expect(resolveAdminTenant({ projectRefs, projectRef: null })).toBeUndefined();
  });
});
