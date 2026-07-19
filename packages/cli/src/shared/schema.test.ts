import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { decodedSchema, parseToolArguments, stringEnum } from "./schema";

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
