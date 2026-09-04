import { describe, expect, test } from "bun:test";
import {
  createMockCommand,
  createMockController,
  createMockGraph,
  createMockModule,
} from "./mock-graph";

describe("Mock Graph Test Utilities (mock-graph.ts)", () => {
  test("createMockModule creates a complete default module node", () => {
    const mod = createMockModule({ name: "cases", tags: ["type:feature"] });
    expect(mod.name).toBe("cases");
    expect(mod.tags).toEqual(["type:feature"]);
    expect(mod.imports).toEqual([]);
    expect(mod.providers).toEqual([]);
    expect(mod.controllers).toEqual([]);
  });

  test("createMockController creates a controller with routes", () => {
    const ctrl = createMockController("/cases", [
      { method: "GET", path: "/:id", handler: "getById" },
    ]);
    expect(ctrl.path).toBe("/cases");
    expect(ctrl.routes).toHaveLength(1);
    expect(ctrl.routes[0].handler).toBe("getById");
  });

  test("createMockCommand creates a command with default permission", () => {
    const cmd = createMockCommand("case.create", { permission: "case:write" });
    expect(cmd.name).toBe("case.create");
    expect(cmd.className).toBe("CasecreateCommand");
    expect(cmd.permission).toBe("case:write");
  });

  test("createMockGraph assembles an application graph", () => {
    const mod1 = createMockModule({ name: "app" });
    const mod2 = createMockModule({ name: "case" });
    const graph = createMockGraph([mod1, mod2]);
    expect(graph.modules).toHaveLength(2);
    expect(graph.externalTokens).toEqual([]);
  });
});
