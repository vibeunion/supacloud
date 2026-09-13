import { describe, expect, it } from "bun:test";
import { Type } from "@sinclair/typebox";
import { ConfigValidationError, decodeConfig } from "./config";

describe("TypeBox configuration decoding", () => {
  const schema = Type.Object({
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    environment: Type.Union([
      Type.Literal("development"),
      Type.Literal("test"),
      Type.Literal("production"),
    ]),
  });

  it("returns a typed configuration for valid values", () => {
    expect(decodeConfig(schema, { port: 3000, environment: "test" })).toEqual({
      port: 3000,
      environment: "test",
    });
  });

  it("reports TypeBox validation issues", () => {
    expect(() => decodeConfig(schema, { port: 0, environment: "invalid" }, "app config"))
      .toThrow(ConfigValidationError);
  });
});
