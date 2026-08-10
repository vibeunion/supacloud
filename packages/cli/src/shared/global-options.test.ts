import { describe, expect, test } from "bun:test";
import { normalizeEnvironmentName, parseGlobalOptions } from "./global-options";

describe("global CLI options", () => {
    test.each([
        [["--env", "test", "project", "get"], "test"],
        [["project", "get", "--env=test"], "test"],
        [["project", "--env", "test", "get"], "test"],
    ])("extracts environment selectors before TypeBox parsing", (args, environmentName) => {
        const parsed = parseGlobalOptions(args);
        expect(parsed.environmentName).toBe(environmentName);
        expect(parsed.args).toEqual(["project", "get"]);
    });

    test("extracts explicit files and production confirmation in both syntaxes", () => {
        expect(parseGlobalOptions([
            "--env-file=./ci.env", "database", "query", "--confirm-production", "prod-ref",
        ])).toEqual({
            envFile: "./ci.env",
            confirmProduction: "prod-ref",
            args: ["database", "query"],
        });
    });

    test.each([
        [["--env", "test", "--env", "prod"], "--env may be provided only once"],
        [["--env-file", "a", "--env-file=b"], "--env-file may be provided only once"],
        [["--confirm-production", "a", "--confirm-production=a"], "--confirm-production may be provided only once"],
        [["--env"], "--env requires a value"],
        [["--env="], "--env requires a value"],
        [["--env", "test", "--env-file", "file"], "mutually exclusive"],
    ])("rejects invalid global option input", (args, message) => {
        expect(() => parseGlobalOptions(args)).toThrow(message);
    });

    test("normalizes valid environment names and rejects unsafe selectors", () => {
        expect(normalizeEnvironmentName("Prod_US-1")).toBe("prod_us-1");
        expect(() => normalizeEnvironmentName("../prod")).toThrow("must match");
        expect(() => normalizeEnvironmentName("a".repeat(65))).toThrow("must match");
    });
});
