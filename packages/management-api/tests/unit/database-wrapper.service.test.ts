import { describe, expect, test } from "bun:test";
import { normalizeWrapperResourceName, wrapperDefinition } from "../../src/services/database-wrapper.service";

describe("database wrapper configuration", () => {
  test("defines the current Stripe and MongoDB wrappers", () => {
    expect(wrapperDefinition("stripe")).toMatchObject({ fdw: "stripe_wrapper", schema: "stripe", importSchema: "stripe" });
    expect(wrapperDefinition("mongodb")).toMatchObject({ fdw: "mongodb_wrapper", schema: "mongo", importSchema: null });
  });

  test("rejects unsafe server and schema identifiers", () => {
    expect(normalizeWrapperResourceName("stripe_server", "server_name")).toBe("stripe_server");
    expect(() => normalizeWrapperResourceName("server; drop schema public", "server_name")).toThrow("identifier");
  });
});
