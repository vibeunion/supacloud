import { expect, test } from "bun:test";
import { resourceScaffold } from "./app-resource";

test("resource generation is async-ready without adding another validator or persistence library", () => {
    const files = resourceScaffold("inventory", "Inventory");
    expect(files["inventory.service.ts"]).toContain("async find(id: string): Promise<InventoryResult>");
    expect(files["inventory.service.ts"]).toContain("return this.reader.readAuthorized(id)");
    expect(files["inventory.controller.ts"]).toContain('find(@Param("id") id: string): Effect.Effect<InventoryResult, never, never>');
    expect(files["inventory.controller.ts"]).toContain('effect: { required: true, dependencies: [], errors: [], retry: "none" }');
    expect(files["inventory.service.ts"]).not.toContain('from "elysia"');
    expect(files["inventory.model.ts"]).toContain("RouteHandlerOutput");
    expect(files["inventory.service.test.ts"]).toContain(".rejects.toThrow");
    expect(files["inventory.controller.test.ts"]).toContain('.rejects.toThrow("read port unavailable")');
    expect(files["inventory.controller.test.ts"]).toContain("expect(await Effect.runPromise(controller.find");
    expect(Object.keys(files)).toHaveLength(6);
});
