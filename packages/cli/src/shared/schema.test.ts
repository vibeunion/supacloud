import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { decodedSchema, parseToolArguments, schemaEnumValues, stringEnum } from "./schema";

describe("TypeBox CLI schema boundary", () => {
    test("parses typed arguments and rejects unknown flags", () => {
        const schema = {
            action: stringEnum(["list", "get"]),
            limit: Type.Optional(Type.Number()),
        };

        expect(parseToolArguments(schema, { action: "list", limit: 5 })).toEqual({
            action: "list",
            limit: 5,
        });
        expect(() => parseToolArguments(schema, { action: "list", unexpected: true }))
            .toThrow("Unexpected property");
    });

    test("decodes transformed fields after validating encoded input", () => {
        const lowercase = decodedSchema(
            Type.String(),
            Type.String({ minLength: 1 }),
            (input) => input.trim().toLowerCase(),
        );

        expect(parseToolArguments({ hostname: lowercase }, { hostname: " EXAMPLE.COM " }))
            .toEqual({ hostname: "example.com" });
    });
});

test("enum metadata includes single literals and multiple alternatives", () => {
    expect(schemaEnumValues(stringEnum(["only"]))).toEqual(["only"]);
    expect(schemaEnumValues(Type.Literal(1))).toEqual(["1"]);
    expect(schemaEnumValues(stringEnum(["first", "second"]))).toEqual(["first", "second"]);
    expect(schemaEnumValues(Type.String())).toEqual([]);
});

test("single-value metadata keeps argument validation strict", () => {
    const schema = { action: stringEnum(["only"]) };
    expect(parseToolArguments(schema, { action: "only" })).toEqual({ action: "only" });
    expect(() => parseToolArguments(schema, { action: "other" })).toThrow("Invalid arguments");
    expect(() => parseToolArguments(schema, { action: "only", extra: true })).toThrow("Invalid arguments");
});
