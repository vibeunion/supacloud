import { describe, test, expect, mock } from "bun:test";

const mockDbFn = Object.assign(
    async () => [{ name: "pg_stat_statements", default_version: "1.10", installed_version: "1.10", comment: "track stats", is_installed: true }],
    {
        close: async () => { },
        unsafe: async () => [{ name: "pg_stat_statements", default_version: "1.10", installed_version: "1.10", comment: "track stats", is_installed: true }],
    }
);

mock.module("../../src/db", () => ({
    getProjectDb: () => mockDbFn,
    resolveDbName: async () => "project_testref123"
}));

import { extensionService } from "../../src/services/extension.service";

describe("ExtensionService", () => {
    test("listExtensions should parse DB output", async () => {
        const extensions = await extensionService.listExtensions("testref123");
        expect(extensions).toHaveLength(1);
        expect(extensions[0].name).toBe("pg_stat_statements");

    test("enableExtension should return success", async () => {
        const result = await extensionService.enableExtension("testref123", "postgis");
        expect(result.message).toContain("enabled");
    });
});
