import { describe, expect, test } from "bun:test";
import {
  actorId,
  appErrorMessage,
  isAuthenticatedActor,
  projectRef,
  requiresTenant,
  tenantId,
  userId,
  type ActorContext,
} from "./index.js";

describe("contract identity and request context", () => {
  test("constructs validated branded identifiers", () => {
    expect(tenantId("tenant-1")).toBe("tenant-1");
    expect(projectRef("project-1")).toBe("project-1");
    expect(() => tenantId("")).toThrow(TypeError);
    expect(() => projectRef("Project-1")).toThrow(TypeError);
  });

  test("narrows authenticated context and requires a tenant", () => {
    const context: ActorContext = {
      kind: "user",
      tenantId: tenantId("tenant-1"),
      actorId: actorId("actor-1"),
      userId: userId("user-1"),
    };
    expect(isAuthenticatedActor(context)).toBe(true);
    expect(requiresTenant(context)).toBe("tenant-1");
  });

  test("formats every app error branch", () => {
    expect(appErrorMessage({ kind: "forbidden", permission: "project:read" }))
      .toBe("Missing permission: project:read");
    expect(appErrorMessage({
      kind: "validation",
      issues: [{ path: ["name"], message: "Required" }],
    })).toBe("name: Required");
  });
});
