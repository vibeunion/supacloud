import { describe, expect, test } from "bun:test";
import { normalizeEnvironmentName, parseGlobalAdminOptions } from "./global-options";

describe("Admin global options", () => {
    test.each([
        [["--env", "test", "project", "list"], "test"],
        [["project", "list", "--env=test"], "test"],
        [["project", "--env", "test", "list"], "test"],
    ])("extracts environment selectors before command parsing", (args, environmentName) => {
        const parsed = parseGlobalAdminOptions(args);
        expect(parsed.environmentName).toBe(environmentName);
        expect(parsed.args).toEqual(["project", "list"]);
    });

    test("extracts an exact file and production confirmation in both syntaxes", () => {
        expect(parseGlobalAdminOptions([
            "--env-file=./ops.env", "project", "delete", "--confirm-production", "prod-ref",
        ])).toEqual({
            envFile: "./ops.env",
            confirmProduction: "prod-ref",
            args: ["project", "delete"],
        });
    });

    test.each([
        [["--env", "test", "--env", "production"], "--env may be provided only once"],
        [["--env-file", "a", "--env-file=b"], "--env-file may be provided only once"],
        [["--confirm-production", "a", "--confirm-production=a"], "--confirm-production may be provided only once"],
        [["--env"], "--env requires a value"],
        [["--env="], "--env requires a value"],
        [["--env", "test", "--env-file", "file"], "mutually exclusive"],
    ])("rejects invalid global option input", (args, message) => {
        expect(() => parseGlobalAdminOptions(args)).toThrow(message);
    });

    test("normalizes production aliases and rejects unsafe selectors", () => {
        expect(normalizeEnvironmentName("Prod")).toBe("production");
        expect(normalizeEnvironmentName("TEST_US-1")).toBe("test_us-1");
        expect(() => normalizeEnvironmentName("../production")).toThrow("must match");
    });
});
